const { test } = require('node:test');
const assert = require('node:assert');
const { loadPage, fakeDb, fakeFile } = require('./support/page');
const A = require('./support/audio');

function setup() {
  const DB = fakeDb();
  const { Library } = loadPage(['tags.js', 'library.js'], { DB });
  return { DB, Library };
}
const entry = (filePath, bytes, counter, lastModified) => ({ file: fakeFile(filePath.split('/').pop(), bytes, lastModified, counter), path: filePath });

test('reads tags, totals included', async () => {
  const { Library } = setup();
  await Library.ingest([entry('Music/a/01.mp3', A.song({ title: 'One', artist: 'The Band', album: 'First', track: '3/12' }))]);
  const [track] = Library.tracks;
  assert.strictEqual(track.title, 'One');
  assert.strictEqual(track.trackNo, 3);
  assert.strictEqual(track.trackTotal, 12);
});

test('falls back to the folder layout when there are no tags', async () => {
  const { Library } = setup();
  await Library.ingest([entry('Music/Rock (3)/Some Band/[1997] An Album/04 A Song.mp3', A.AUDIO)]);
  const [track] = Library.tracks;
  assert.deepStrictEqual([track.title, track.artist, track.album, track.year, track.trackNo, track.genre], ['A Song', 'Some Band', 'An Album', 1997, 4, 'Rock']);
});

test('sorts by artist ignoring "The", then album year, then track', async () => {
  const { Library } = setup();
  await Library.ingest([
    entry('m/1.mp3', A.song({ title: 'Z', artist: 'Zebra', album: 'A', year: 2000 })),
    entry('m/2.mp3', A.song({ title: 'Later', artist: 'The Antlers', album: 'New', year: 2010, track: '1' })),
    entry('m/3.mp3', A.song({ title: 'Two', artist: 'The Antlers', album: 'Old', year: 2001, track: '2' })),
    entry('m/4.mp3', A.song({ title: 'One', artist: 'The Antlers', album: 'Old', year: 2001, track: '1' })),
  ]);
  assert.deepStrictEqual([...Library.tracks].map((t) => t.title), ['One', 'Two', 'Later', 'Z']);
});

test('a key ignores case and accents, and changes when the song does', () => {
  const { Library } = setup();
  const meta = { artist: 'Björk', album: 'Post', discNo: 1, trackNo: 1, title: 'Army' };
  assert.strictEqual(Library.keyFor(meta), Library.keyFor({ ...meta, artist: 'BJORK', title: 'ARMY' }));
  assert.notStrictEqual(Library.keyFor(meta), Library.keyFor({ ...meta, title: 'Hyper' }));
});

test('search looks across title, artist and album', async () => {
  const { Library } = setup();
  await Library.ingest([entry('m/1.mp3', A.song({ title: 'Halcyon', artist: 'Violet', album: 'Glow' })), entry('m/2.mp3', A.song({ title: 'Other', artist: 'Someone', album: 'Else' }))]);
  assert.strictEqual(Library.search('viol halc').length, 1);
  assert.strictEqual(Library.search('nothing').length, 0);
});

test('a fully tagged file that moves is not read again', async () => {
  const { Library } = setup();
  const bytes = A.song({ title: 'One', year: 2000 });
  const counter = { reads: 0 };
  await Library.ingest([entry('Music/Old Folder/01.mp3', bytes, counter)]);
  assert(counter.reads > 0);
  counter.reads = 0;
  await Library.ingest([entry('Music/New Folder/01.mp3', bytes, counter)]);
  assert.strictEqual(counter.reads, 0, 'the tags were read again');
  assert.strictEqual(Library.tracks[0].path, 'Music/New Folder/01.mp3');
});

test('a file relying on its folder for details is read again when moved', async () => {
  const { Library } = setup();
  const counter = { reads: 0 };
  await Library.ingest([entry('Music/Rock (1)/Band/[2000] One/01 Song.mp3', A.AUDIO, counter)]);
  assert.strictEqual(Library.tracks[0].genre, 'Rock');
  counter.reads = 0;
  await Library.ingest([entry('Music/Jazz (1)/Band/[2000] One/01 Song.mp3', A.AUDIO, counter)]);
  assert(counter.reads > 0);
  assert.strictEqual(Library.tracks[0].genre, 'Jazz');
});

test('a changed file is read again', async () => {
  const { Library } = setup();
  const counter = { reads: 0 };
  await Library.ingest([entry('m/1.mp3', A.song({ title: 'Before' }), counter, 1000)]);
  counter.reads = 0;
  await Library.ingest([entry('m/1.mp3', A.song({ title: 'After' }), counter, 2000)]);
  assert(counter.reads > 0);
  assert.strictEqual(Library.tracks[0].title, 'After');
});

test('tags cached by an older version are still used', async () => {
  const { DB, Library } = setup();
  const bytes = A.song({ title: 'From Tags' });
  const file = fakeFile('1.mp3', bytes);
  DB.stores.tags.set(`v3|m/1.mp3|${file.size}|${file.lastModified}`, { title: 'From Old Cache', artist: 'A', album: 'B' });
  await Library.ingest([{ file, path: 'm/1.mp3' }]);
  assert.strictEqual(Library.tracks[0].title, 'From Old Cache');
});
