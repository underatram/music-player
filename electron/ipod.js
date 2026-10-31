// Finds a connected iPod and summarises what's on it. Everything here only reads.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const Id3 = require('./id3');

const MOUNT_ROOTS = (user) => [`/run/media/${user}`, `/media/${user}`];
const EJECT_TIMEOUT_MS = 30000;
const MAC_EPOCH_SECONDS = 2082844800; // iPods count from 1904
const BACKUPS_KEPT = 3;
const FIELD_SEPARATOR = '\x1f';
const BACKED_UP_FILES = ['iTunes/iTunesDB', 'iTunes/Play Counts', 'Artwork/ArtworkDB'];
const GENRE_KINDS = { podcast: 'podcasts', audiobook: 'audiobooks' };
// The family numbers Apple reports for models that work as a plain USB drive.
const FAMILY_NAMES = {
  1: 'iPod', 2: 'iPod', 3: 'iPod', 4: 'iPod', 5: 'iPod mini', 6: 'iPod photo', 7: 'iPod (5th generation)',
  8: 'iPod nano', 9: 'iPod nano', 10: 'iPod shuffle', 11: 'iPod classic', 12: 'iPod nano', 13: 'iPod shuffle',
  14: 'iPod nano', 15: 'iPod nano', 16: 'iPod shuffle', 17: 'iPod nano', 18: 'iPod shuffle', 19: 'iPod nano',
};

const USB_DEVICES = '/sys/bus/usb/devices';
const BLOCK_DEVICES = '/sys/block';
const APPLE_VENDOR = '05ac';

let cached = null; // the last summary, kept until the database file changes
let syncing = null; // the helper while it's running

function readWithoutTouching(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOATIME);
  } catch {
    fd = fs.openSync(file, fs.constants.O_RDONLY);
  }
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function findMount() {
  const user = process.env.USER || process.env.LOGNAME || '';
  for (const root of MOUNT_ROOTS(user)) {
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const mount = path.join(root, name);
      if (fs.existsSync(path.join(mount, 'iPod_Control', 'iTunes', 'iTunesDB'))) return mount;
    }
  }
  return null;
}

// An iPod can be plugged in without being usable as a drive. After an eject it
// stays on USB with its disk reporting no size until it's reconnected.
function findUnmounted() {
  let names;
  try {
    names = fs.readdirSync(USB_DEVICES);
  } catch {
    return null;
  }
  const usb = names.map((name) => path.join(USB_DEVICES, name)).find((device) => {
    try {
      return fs.readFileSync(path.join(device, 'idVendor'), 'utf8').trim() === APPLE_VENDOR
        && /iPod/.test(fs.readFileSync(path.join(device, 'product'), 'utf8'));
    } catch {
      return false;
    }
  });
  if (!usb) return null;

  const usbPath = fs.realpathSync(usb);
  for (const disk of fs.readdirSync(BLOCK_DEVICES)) {
    const block = path.join(BLOCK_DEVICES, disk);
    let device;
    try {
      device = fs.realpathSync(path.join(block, 'device'));
    } catch {
      continue;
    }
    if (!device.startsWith(`${usbPath}/`)) continue;
    const size = Number(fs.readFileSync(path.join(block, 'size'), 'utf8'));
    if (!size) return { state: 'ejected' };
    const partition = fs.readdirSync(block).find((name) => name.startsWith(disk));
    return partition ? { state: 'unmounted', device: `/dev/${partition}` } : { state: 'starting' };
  }
  // Newer models connect without a disk at all, and aren't supported.
  return null;
}

function parseDatabase(db) {
  const u32 = (at) => db.readUInt32LE(at);
  if (db.toString('latin1', 0, 4) !== 'mhbd') throw new Error('Not an iPod database');

  const strings = (at, count, wanted) => {
    const found = {};
    let q = at;
    for (let i = 0; i < count; i++) {
      const kind = u32(q + 12);
      if (wanted.includes(kind)) found[kind] = db.toString('utf16le', q + 40, q + 40 + u32(q + 28));
      q += u32(q + 8);
    }
    return found;
  };

  const kinds = {
    music: { songs: 0, bytes: 0 },
    podcasts: { songs: 0, bytes: 0 },
    audiobooks: { songs: 0, bytes: 0 },
  };
  const tracks = [];
  let milliseconds = 0;
  let plays = 0;
  let playlists = null;
  let name = '';

  let section = u32(4);
  for (let i = 0; i < u32(20); i++) {
    const total = u32(section + 8);
    const type = u32(section + 12);
    const list = section + u32(section + 4);
    if (type === 1) {
      let p = list + u32(list + 4);
      for (let n = 0; n < u32(list + 8); n++) {
        const text = strings(p + u32(p + 4), u32(p + 12), [1, 2, 3, 4, 5]);
        const { 5: genre = '' } = text;
        tracks.push({
          path: text[2] || '',
          title: text[1] || '',
          album: text[3] || '',
          artist: text[4] || '',
          trackNo: u32(p + 44),
          trackTotal: u32(p + 48),
          discNo: u32(p + 92),
          discTotal: u32(p + 96),
          plays: u32(p + 80),
          lastPlayed: u32(p + 88),
        });
        const kind = GENRE_KINDS[genre.trim().toLowerCase()] || 'music';
        kinds[kind].songs += 1;
        kinds[kind].bytes += u32(p + 36);
        milliseconds += u32(p + 40);
        plays += u32(p + 80);
        p += u32(p + 8);
      }
    } else if (type === 2 || (type === 3 && !playlists)) {
      const found = [];
      let p = list + u32(list + 4);
      for (let n = 0; n < u32(list + 8); n++) {
        const { 1: title = '' } = strings(p + u32(p + 4), u32(p + 12), [1]);
        const isMaster = Boolean(db[p + 20]);
        if (isMaster) name = title;
        else found.push({ name: title, songs: u32(p + 16) });
        p += u32(p + 8);
      }
      if (type === 3 || !playlists) playlists = found;
    }
    section += total;
  }
  return { name, kinds, milliseconds, plays, tracks, playlists: playlists || [] };
}

// Plays since the last sync wait in a separate file, in the same order as the songs.
function addPlayCounts(contents, file) {
  let counts;
  try {
    counts = readWithoutTouching(file);
  } catch {
    return;
  }
  if (counts.toString('latin1', 0, 4) !== 'mhdp') return;
  const header = counts.readUInt32LE(4);
  const entry = counts.readUInt32LE(8);
  const number = Math.min(counts.readUInt32LE(12), contents.tracks.length);
  for (let i = 0; i < number; i++) {
    const at = header + i * entry;
    const played = counts.readUInt32LE(at);
    if (!played) continue;
    const track = contents.tracks[i];
    track.plays += played;
    track.lastPlayed = Math.max(track.lastPlayed, counts.readUInt32LE(at + 4));
    contents.plays += played;
  }
}

function describeModel(mount) {
  const info = path.join(mount, 'iPod_Control', 'Device', 'SysInfoExtended');
  try {
    const family = /<key>FamilyID<\/key>\s*<integer>(\d+)<\/integer>/.exec(readWithoutTouching(info).toString('utf8'));
    if (family && FAMILY_NAMES[family[1]]) return FAMILY_NAMES[family[1]];
  } catch {
    // Most iPods don't have this file until something creates it.
  }
  return 'iPod';
}

// A summary of the connected iPod, or null if there isn't one.
function describe() {
  // The database is being rewritten, so what's on the iPod isn't settled yet.
  if (syncing) return syncing.lastSeen;
  const mount = findMount();
  if (!mount) {
    cached = null;
    const waiting = findUnmounted();
    return waiting ? { state: waiting.state } : null;
  }
  const database = path.join(mount, 'iPod_Control', 'iTunes', 'iTunesDB');
  const { mtimeMs, size } = fs.statSync(database);
  const stamp = `${mount}|${mtimeMs}|${size}`;
  if (!cached || cached.stamp !== stamp) {
    let contents = null;
    try {
      contents = parseDatabase(readWithoutTouching(database));
      addPlayCounts(contents, path.join(mount, 'iPod_Control', 'iTunes', 'Play Counts'));
    } catch (err) {
      console.warn('Could not read the iPod database', err);
    }
    cached = { stamp, contents, model: describeModel(mount) };
  }
  const { bsize, blocks, bavail } = fs.statfsSync(mount);
  return {
    state: 'ready',
    mount,
    label: path.basename(mount),
    model: cached.model,
    capacity: bsize * blocks,
    free: bsize * bavail,
    lastSynced: mtimeMs,
    contents: cached.contents && { ...cached.contents, tracks: undefined },
  };
}

// Every song on the iPod, for working out what a sync would change.
function songs() {
  describe();
  if (!cached || !cached.contents) return [];
  return cached.contents.tracks.map((track) => ({
    ...track,
    lastPlayed: track.lastPlayed ? (track.lastPlayed - MAC_EPOCH_SECONDS) * 1000 : 0,
  }));
}

function backUp(mount, backupRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folder = path.join(backupRoot, stamp);
  fs.mkdirSync(folder, { recursive: true });
  for (const file of BACKED_UP_FILES) {
    const source = path.join(mount, 'iPod_Control', file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(folder, path.basename(file)));
  }
  const old = fs.readdirSync(backupRoot).sort().slice(0, -BACKUPS_KEPT);
  for (const name of old) fs.rmSync(path.join(backupRoot, name), { recursive: true, force: true });
}

const clean = (value) => String(value ?? '').replace(/[\x1f\n\r]/g, ' ');

// Writes each album's cover to a temporary file, once, for the helper to use.
async function coverFiles(additions, folder) {
  const byAlbum = new Map();
  for (const song of additions) {
    if (byAlbum.has(song.albumKey)) continue;
    let file = '';
    try {
      const image = await Id3.readCover(song.fullPath);
      if (image) {
        file = path.join(folder, `${byAlbum.size}.img`);
        fs.writeFileSync(file, image);
      }
    } catch (err) {
      console.warn(`Could not read the cover of ${song.fullPath}`, err);
    }
    byAlbum.set(song.albumKey, file);
  }
  return byAlbum;
}

// request: { removals: [paths on the iPod], additions: [songs], updates: [new numbers] }
async function sync(request, { helper, backupRoot, onProgress }) {
  if (syncing) throw new Error('A sync is already running.');
  const mount = findMount();
  if (!mount) throw new Error('Your iPod isn\'t connected.');
  if (!fs.existsSync(helper)) throw new Error('The iPod helper is missing from this install.');

  const lastSeen = describe();
  const before = cached.contents.tracks.length;
  backUp(mount, backupRoot);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'music-ipod-'));
  try {
    onProgress({ phase: 'preparing' });
    const covers = await coverFiles(request.additions, temporary);
    const lines = [
      ...request.removals.map((ipodPath) => `R${FIELD_SEPARATOR}${clean(ipodPath)}`),
      ...request.updates.map((song) => ['U', song.path, song.trackNo, song.trackTotal, song.discNo, song.discTotal].map(clean).join(FIELD_SEPARATOR)),
      ...request.additions.map((song) => ['A', song.fullPath, song.title, song.artist, song.albumArtist, song.album, song.genre,
        song.year, song.trackNo, song.trackTotal, song.discNo, song.discTotal, song.compilation ? 1 : 0, song.duration, song.size, covers.get(song.albumKey)]
        .map(clean).join(FIELD_SEPARATOR)),
    ];

    const result = await new Promise((resolve, reject) => {
      const child = spawn(helper, ['sync', mount], { stdio: ['pipe', 'pipe', 'ignore'] });
      syncing = { child, lastSeen };
      const failures = [];
      let problem = null;
      let finished = null;
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const parts = buffer.split('\n');
        buffer = parts.pop();
        for (const line of parts) {
          const [code, ...rest] = line.split(' ');
          if (code === 'P') onProgress({ phase: 'copying', done: Number(rest[0]) + 1, total: request.additions.length });
          else if (code === 'X') onProgress({ phase: 'removed', removed: Number(rest[0]) });
          else if (code === 'W') onProgress({ phase: 'saving' });
          else if (code === 'F') failures.push({ title: request.additions[Number(rest[0])].title, message: rest.slice(1).join(' ') });
          else if (code === 'E') problem = rest.join(' ');
          else if (code === 'D') finished = { removed: Number(rest[0]), added: Number(rest[1]), updated: Number(rest[2]) };
        }
      });
      child.on('error', reject);
      child.on('close', (code) => {
        // A helper that can't start usually means the iPod library isn't installed.
        if (code === 127) reject(new Error('The iPod library isn\'t installed. Run: sudo apt install libgpod4t64 libgpod-common'));
        else if (finished) resolve({ ...finished, failures });
        else reject(new Error(problem || 'The sync stopped unexpectedly.'));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(`${lines.join('\n')}\n`);
    });

    syncing = null;
    cached = null;
    describe();
    const after = cached && cached.contents ? cached.contents.tracks.length : null;
    if (after !== before - result.removed + result.added) {
      throw new Error(`The iPod lists ${after} songs, not the ${before - result.removed + result.added} expected. A copy of its old database is saved.`);
    }
    return { ...result, songsNow: after };
  } finally {
    syncing = null;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function stopSync() {
  if (syncing) syncing.child.kill('SIGTERM');
}

function eject() {
  if (syncing) return Promise.reject(new Error('Wait for the sync to finish first.'));
  const mount = findMount();
  if (!mount) return Promise.resolve();
  return new Promise((resolve, reject) => {
    execFile('gio', ['mount', '--eject', mount], { timeout: EJECT_TIMEOUT_MS }, (err) => {
      if (err) reject(new Error('The iPod is busy. Close anything using it and try again.'));
      else resolve();
    });
  });
}

// Mounts an iPod that's plugged in but hasn't appeared as a drive.
function mount() {
  const waiting = findUnmounted();
  if (!waiting || !waiting.device) return Promise.reject(new Error('Unplug your iPod and plug it back in.'));
  return new Promise((resolve, reject) => {
    execFile('gio', ['mount', '--device', waiting.device], { timeout: EJECT_TIMEOUT_MS }, (err) => {
      if (err) reject(new Error('Couldn\'t open your iPod. Try unplugging it and plugging it back in.'));
      else resolve();
    });
  });
}

module.exports = { describe, eject, mount, parseDatabase, songs, sync, stopSync };
