// Builds the helper and a fake iPod. Tests using these skip themselves if libgpod's
// development files aren't installed.
const fs = require('node:fs');
const path = require('node:path');
const { execSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const HELPER = path.join(ROOT, 'native', 'ipod-helper');
const GUID = '0x000A270000000001';

function flags() {
  return execSync('pkg-config --cflags --libs libgpod-1.0', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

const canBuild = () => {
  try {
    flags();
    return true;
  } catch {
    return false;
  }
};

function buildTools(workDir) {
  const cflags = flags();
  execSync(`gcc -O1 native/ipod-helper.c -o native/ipod-helper ${cflags}`, { cwd: ROOT, stdio: 'ignore' });
  const maker = path.join(workDir, 'make-ipod');
  execSync(`gcc tests/support/make-ipod.c -o "${maker}" ${cflags}`, { cwd: ROOT, stdio: 'ignore' });
  return maker;
}

function makeIpod(maker, mount) {
  fs.mkdirSync(mount, { recursive: true });
  execSync(`"${maker}" "${mount}"`, { stdio: 'ignore' });
  // Real iPods report a model number with a leading letter, which libgpod skips, and
  // an ID that the database's protection is worked out from.
  fs.writeFileSync(path.join(mount, 'iPod_Control', 'Device', 'SysInfo'), `ModelNumStr: xC297\nFirewireGuid: ${GUID}\n`);
  // A blank iPod comes without its music folders until something makes them.
  for (let i = 0; i < 50; i++) fs.mkdirSync(path.join(mount, 'iPod_Control', 'Music', `F${String(i).padStart(2, '0')}`), { recursive: true });
}

const SEP = '\x1f';
const addLine = (file, s) => ['A', file, s.title, s.artist || 'Artist', s.albumArtist || '', s.album || 'Album', s.genre || 'Rock', s.year || 2001, s.track ?? 1, s.trackTotal ?? 1, s.disc ?? 1, s.discTotal ?? 1, 0, s.seconds || 10, fs.statSync(file).size, s.cover || ''].join(SEP);
const removeLine = (ipodPath) => `R${SEP}${ipodPath}`;
const listLine = (name, songs) => ['L', name, ...songs].join(SEP);
const deleteListLine = (name) => `K${SEP}${name}`;
const updateLine = (u) => ['U', u.path, u.track, u.trackTotal, u.disc, u.discTotal].join(SEP);

function runHelper(mount, lines, { signalAfterFirstSong = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(HELPER, ['sync', mount], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (signalAfterFirstSong && /^P 0$/m.test(out)) child.kill('SIGTERM');
    });
    child.on('close', (code) => resolve({ code, out: out.trim().split('\n') }));
    child.stdin.on('error', () => {});
    child.stdin.end(lines.length ? `${lines.join('\n')}\n` : '');
  });
}

module.exports = { canBuild, buildTools, makeIpod, runHelper, addLine, removeLine, updateLine, listLine, deleteListLine };
