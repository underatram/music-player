// Runs the real helper and the real libgpod against a fake iPod in a temporary folder.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ipod = require('../electron/ipod');
const A = require('./support/audio');
const F = require('./support/fake-ipod');

const skip = F.canBuild() ? false : 'libgpod-dev, pkg-config or gcc is missing';

let dir;
let maker;
let mp3;
let cover;
let serial = 0;
before(() => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-ipod-test-'));
  maker = F.buildTools(dir);
  mp3 = path.join(dir, 'song.mp3');
  fs.writeFileSync(mp3, A.song({ title: 'Source' }));
  cover = path.join(dir, 'cover.png');
  fs.writeFileSync(cover, A.TINY_PNG);
});
after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function newIpod() {
  const mount = path.join(dir, `ipod${serial++}`);
  F.makeIpod(maker, mount);
  return mount;
}
const database = (mount) => path.join(mount, 'iPod_Control', 'iTunes', 'iTunesDB');
const read = (mount) => Ipod.parseDatabase(fs.readFileSync(database(mount)));
const onDisk = (mount, ipodPath) => path.join(mount, ...ipodPath.split(':').filter(Boolean));
const musicFiles = (mount) => {
  const found = [];
  const root = path.join(mount, 'iPod_Control', 'Music');
  for (const folder of fs.readdirSync(root)) found.push(...fs.readdirSync(path.join(root, folder)));
  return found;
};
const add = (title, extra = {}) => F.addLine(mp3, { title, ...extra });

test('adds songs with their numbers and copies the files', { skip }, async () => {
  const mount = newIpod();
  const { code, out } = await F.runHelper(mount, [
    add('One', { track: 1, trackTotal: 2, disc: 1, discTotal: 1, album: 'First', cover }),
    add('Two', { track: 2, trackTotal: 2, disc: 1, discTotal: 1, album: 'First', cover }),
  ]);
  assert.strictEqual(code, 0, out.join('|'));
  assert.strictEqual(out.at(-1), 'D 0 2 0');
  const { tracks, name, kinds } = read(mount);
  assert.strictEqual(name, 'Test iPod');
  assert.strictEqual(kinds.music.songs, 2);
  const one = tracks.find((t) => t.title === 'One');
  assert.deepStrictEqual([one.trackNo, one.trackTotal, one.discNo, one.discTotal, one.album], [1, 2, 1, 1, 'First']);
  for (const t of tracks) assert(fs.existsSync(onDisk(mount, t.path)), `missing ${t.path}`);
  assert.strictEqual(musicFiles(mount).length, 2);
  assert(fs.readFileSync(onDisk(mount, one.path)).equals(fs.readFileSync(mp3)), 'the copy differs');
});

test('the saved database carries its protection', { skip }, async () => {
  const mount = newIpod();
  await F.runHelper(mount, [add('One')]);
  const db = fs.readFileSync(database(mount));
  assert(db.subarray(0x58, 0x58 + 20).some(Boolean), 'an iPod would reject this database');
});

test('removes only what it\'s told to, and deletes the files', { skip }, async () => {
  const mount = newIpod();
  await F.runHelper(mount, [add('Keep'), add('Remove')]);
  const before2 = read(mount).tracks;
  const gone = before2.find((t) => t.title === 'Remove');
  const kept = before2.find((t) => t.title === 'Keep');
  const { code, out } = await F.runHelper(mount, [F.removeLine(gone.path)]);
  assert.strictEqual(code, 0);
  assert.strictEqual(out.at(-1), 'D 1 0 0');
  assert.deepStrictEqual(read(mount).tracks.map((t) => t.title), ['Keep']);
  assert(!fs.existsSync(onDisk(mount, gone.path)), 'the file stayed');
  assert(fs.existsSync(onDisk(mount, kept.path)), 'the wrong file went');
});

test('removing a path that isn\'t there does nothing', { skip }, async () => {
  const mount = newIpod();
  await F.runHelper(mount, [add('Keep')]);
  const { code, out } = await F.runHelper(mount, [F.removeLine(':iPod_Control:Music:F00:NONE.mp3')]);
  assert.strictEqual(code, 0);
  assert.strictEqual(out.at(-1), 'D 0 0 0');
  assert.strictEqual(read(mount).tracks.length, 1);
});

test('removes and adds in one sync', { skip }, async () => {
  const mount = newIpod();
  await F.runHelper(mount, [add('Old')]);
  const [old] = read(mount).tracks;
  const { out } = await F.runHelper(mount, [F.removeLine(old.path), add('New')]);
  assert.strictEqual(out.at(-1), 'D 1 1 0');
  assert.deepStrictEqual(read(mount).tracks.map((t) => t.title), ['New']);
  assert.strictEqual(musicFiles(mount).length, 1);
});

test('updates numbers without touching the song\'s file', { skip }, async () => {
  const mount = newIpod();
  await F.runHelper(mount, [add('One', { track: 1, trackTotal: 0, disc: 1, discTotal: 0 })]);
  const [song] = read(mount).tracks;
  const file = onDisk(mount, song.path);
  const stamp = fs.statSync(file).mtimeMs;
  const { out } = await F.runHelper(mount, [F.updateLine({ path: song.path, track: 1, trackTotal: 12, disc: 1, discTotal: 1 })]);
  assert.strictEqual(out.at(-1), 'D 0 0 1');
  const [updated] = read(mount).tracks;
  assert.deepStrictEqual([updated.trackNo, updated.trackTotal, updated.discNo, updated.discTotal, updated.path], [1, 12, 1, 1, song.path]);
  assert.strictEqual(fs.statSync(file).mtimeMs, stamp);
});

test('a bad instruction changes nothing at all', { skip }, async () => {
  const mount = newIpod();
  await F.runHelper(mount, [add('Keep')]);
  const original = A.sha(fs.readFileSync(database(mount)));
  const [keep] = read(mount).tracks;
  const { code, out } = await F.runHelper(mount, [F.removeLine(keep.path), 'nonsense']);
  assert.notStrictEqual(code, 0);
  assert(out.at(-1).startsWith('E '));
  assert.strictEqual(A.sha(fs.readFileSync(database(mount))), original, 'the database changed');
  assert(fs.existsSync(onDisk(mount, keep.path)));
});

test('refuses to write to an iPod it can\'t identify', { skip }, async () => {
  const mount = newIpod();
  await F.runHelper(mount, [add('Keep')]);
  fs.writeFileSync(path.join(mount, 'iPod_Control', 'Device', 'SysInfo'), '');
  const original = A.sha(fs.readFileSync(database(mount)));
  const { code, out } = await F.runHelper(mount, [add('New')]);
  assert.notStrictEqual(code, 0);
  assert.match(out.at(-1), /model is unknown/);
  assert.strictEqual(A.sha(fs.readFileSync(database(mount))), original);
});

test('a song that can\'t be copied is reported and the rest carry on', { skip }, async () => {
  const mount = newIpod();
  const good = add('Good');
  const bad = add('Bad').replace(mp3, path.join(dir, 'no-such-file.mp3'));
  const { code, out } = await F.runHelper(mount, [bad, good]);
  assert.strictEqual(code, 0);
  assert(out.some((l) => l.startsWith('F 0 ')));
  assert.strictEqual(out.at(-1), 'D 0 1 0');
  assert.deepStrictEqual(read(mount).tracks.map((t) => t.title), ['Good']);
});

test('being stopped saves what\'s been copied, cleanly', { skip }, async () => {
  const mount = newIpod();
  const { code, out } = await F.runHelper(mount, Array.from({ length: 40 }, (_, i) => add(`Song ${i}`)), { signalAfterFirstSong: true });
  assert.strictEqual(code, 0);
  const finished = /^D 0 (\d+) 0$/.exec(out.at(-1));
  assert(finished, out.at(-1));
  const count = Number(finished[1]);
  assert(count >= 1 && count < 40, `copied ${count}`);
  assert.strictEqual(read(mount).tracks.length, count);
  assert.strictEqual(musicFiles(mount).length, count);
});

test('plays waiting in the Play Counts file are read', { skip }, async () => {
  const mount = newIpod();
  await F.runHelper(mount, [add('First'), add('Second')]);
  const contents = read(mount);
  const entry = 28;
  const counts = Buffer.alloc(32 + entry * 2);
  counts.write('mhdp');
  counts.writeUInt32LE(32, 4);
  counts.writeUInt32LE(entry, 8);
  counts.writeUInt32LE(2, 12);
  counts.writeUInt32LE(4, 32 + entry);
  counts.writeUInt32LE(3000000000, 32 + entry + 4);
  const file = path.join(dir, 'counts');
  fs.writeFileSync(file, counts);
  Ipod.addPlayCounts(contents, file);
  assert.strictEqual(contents.plays, 4);
  assert.deepStrictEqual(contents.tracks.map((t) => t.plays), [0, 4]);
  assert.strictEqual(contents.tracks[1].lastPlayed, 3000000000);
});

test('a file that isn\'t a database is rejected', () => {
  assert.throws(() => Ipod.parseDatabase(Buffer.from('not a database at all')));
});
