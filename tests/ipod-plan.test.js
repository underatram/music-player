// This logic decides what gets deleted from someone's iPod.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadPage } = require('./support/page');

const { IpodPlan } = loadPage(['ipod-plan.js']);
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const lib = (title, album = 'Album', extra = {}) => ({ title, album, albumKey: album, trackNo: 1, trackTotal: 1, discNo: 1, discTotal: 1, ...extra });
const pod = (title, album = 'Album', extra = {}) => ({ path: `:F00:${title}.mp3`, title, album, trackNo: 1, trackTotal: 1, discNo: 1, discTotal: 1, ...extra });
const plan = (wanted, ipodSongs) => IpodPlan.compute({ wanted, ipodSongs, fold });
const titles = (list) => [...list].map((t) => t.title);

test('never syncs without a library', () => {
  const ready = { driveMissing: false, refreshing: false, scanning: false, songCount: 10 };
  assert.strictEqual(IpodPlan.canSync(ready), true);
  assert.strictEqual(IpodPlan.canSync({ ...ready, songCount: 0 }), false, 'empty library');
  assert.strictEqual(IpodPlan.canSync({ ...ready, driveMissing: true }), false, 'drive unplugged');
  assert.strictEqual(IpodPlan.canSync({ ...ready, refreshing: true }), false, 'checking the folder');
  assert.strictEqual(IpodPlan.canSync({ ...ready, scanning: true }), false, 'reading the library');
});

test('adds what\'s missing and removes what isn\'t wanted', () => {
  const p = plan([lib('Keep'), lib('New')], [pod('Keep'), pod('Gone')]);
  assert.deepStrictEqual(titles(p.additions), ['New']);
  assert.deepStrictEqual(titles(p.removals), ['Gone']);
});

test('a song in both places is left alone', () => {
  const p = plan([lib('Same')], [pod('Same')]);
  assert.strictEqual(p.additions.length, 0);
  assert.strictEqual(p.removals.length, 0);
  assert.strictEqual(p.updates.length, 0);
});

test('matching ignores case and accents', () => {
  const p = plan([lib('Café', 'ÁLBUM')], [pod('cafe', 'album')]);
  assert.strictEqual(p.additions.length, 0);
  assert.strictEqual(p.removals.length, 0);
});

test('the same title on different albums are different songs', () => {
  const p = plan([lib('Intro', 'One')], [pod('Intro', 'Two')]);
  assert.strictEqual(p.additions.length, 1);
  assert.strictEqual(p.removals.length, 1);
});

test('wanting nothing removes everything, so callers must check canSync', () => {
  const p = plan([], [pod('A'), pod('B')]);
  assert.strictEqual(p.removals.length, 2);
});

test('removals carry the iPod\'s own path', () => {
  const p = plan([], [pod('A')]);
  assert.strictEqual(p.removals[0].path, ':F00:A.mp3');
});

test('blank totals are worked out, which keeps albums in track order on an iPod', () => {
  const tracks = [lib('A', 'X', { trackNo: 1, trackTotal: 0, discNo: 0, discTotal: 0 }), lib('B', 'X', { trackNo: 2, trackTotal: 0, discNo: 0, discTotal: 0 })];
  const numbers = IpodPlan.numbersFor(tracks);
  assert.deepStrictEqual({ ...numbers.get(tracks[0]) }, { trackNo: 1, trackTotal: 2, discNo: 1, discTotal: 1 });
  assert.deepStrictEqual({ ...numbers.get(tracks[1]) }, { trackNo: 2, trackTotal: 2, discNo: 1, discTotal: 1 });
});

test('totals in the tags win, and never fall below the number itself', () => {
  const tracks = [lib('A', 'X', { trackNo: 3, trackTotal: 12, discNo: 2, discTotal: 3 }), lib('B', 'Y', { trackNo: 9, trackTotal: 0, discNo: 2, discTotal: 0 })];
  const numbers = IpodPlan.numbersFor(tracks);
  assert.deepStrictEqual({ ...numbers.get(tracks[0]) }, { trackNo: 3, trackTotal: 12, discNo: 2, discTotal: 3 });
  assert.deepStrictEqual({ ...numbers.get(tracks[1]) }, { trackNo: 9, trackTotal: 9, discNo: 2, discTotal: 2 });
});

test('songs with blank totals on the iPod get updated, not recopied', () => {
  const p = plan([lib('A', 'X', { trackNo: 2, trackTotal: 12, discNo: 1, discTotal: 1 })], [pod('A', 'X', { trackNo: 2, trackTotal: 0, discNo: 1, discTotal: 0 })]);
  assert.strictEqual(p.additions.length, 0);
  assert.strictEqual(p.removals.length, 0);
  assert.strictEqual(p.updates.length, 1);
  const [update] = p.updates;
  assert.deepStrictEqual([update.path, update.trackNo, update.trackTotal, update.discNo, update.discTotal], [':F00:A.mp3', 2, 12, 1, 1]);
});
