// The tag writer changes people's music files, so its promises are tested here:
// audio is never altered, and a failure leaves the original exactly as it was.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readDetails, readCover, writeTags } = require('../electron/id3');
const A = require('./support/audio');

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-id3-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const write = (name, ...parts) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
};
const audioOf = (file) => {
  const b = fs.readFileSync(file);
  const start = A.tagEnd(b);
  return b.subarray(start, start + A.AUDIO.length);
};
const assertAudioKept = (file) => assert.strictEqual(A.sha(audioOf(file)), A.sha(A.AUDIO), 'audio changed');
const frameIds = (file) => {
  const b = fs.readFileSync(file);
  const end = A.tagEnd(b);
  const ids = [];
  let at = 10;
  while (at + 10 <= end && /^[A-Z0-9]{4}$/.test(b.toString('latin1', at, at + 4))) {
    ids.push(b.toString('latin1', at, at + 4));
    const size = b[3] === 4 ? (b[at + 4] << 21) | (b[at + 5] << 14) | (b[at + 6] << 7) | b[at + 7] : b.readUInt32BE(at + 4);
    at += 10 + size;
  }
  return ids;
};
const leftovers = () => fs.readdirSync(dir).filter((n) => n.includes('.saving'));

test('a tweak changes one field and keeps everything else', async () => {
  const f = write('a.mp3', A.v23([['TIT2', A.utf16('Old')], ['TPE1', A.latin('Band')], ['TALB', A.utf16('Album')], ['TRCK', A.latin('3/12')], ['APIC', A.apic('image/jpeg', A.JPEG)], ['TSOP', A.latin('Band, The')], ['USLT', Buffer.from('\0eng\0words')], ['COMM', A.comm('other', 'iTunNORM')], ['COMM', A.comm('hello')]]), A.AUDIO);
  await writeTags(f, { changes: { title: 'Néw Títle ✓' } });
  const d = await readDetails(f);
  assert.strictEqual(d.title, 'Néw Títle ✓');
  assert.strictEqual(d.artist, 'Band');
  assert.strictEqual(d.track, '3');
  assert.strictEqual(d.trackTotal, '12');
  assert.strictEqual(d.comment, 'hello');
  const ids = frameIds(f);
  for (const id of ['APIC', 'TSOP', 'USLT']) assert(ids.includes(id), `lost ${id}`);
  assert.strictEqual(ids.filter((i) => i === 'COMM').length, 2);
  assert(fs.readFileSync(f).includes(A.JPEG), 'cover kept');
  assertAudioKept(f);
  assert.deepStrictEqual(leftovers(), []);
});

test('an empty value removes that field', async () => {
  const f = write('b.mp3', A.v23([['TIT2', A.latin('T')], ['TCON', A.latin('Rock')]]), A.AUDIO);
  await writeTags(f, { changes: { genre: '' } });
  const d = await readDetails(f);
  assert.strictEqual(d.genre, '');
  assert.strictEqual(d.title, 'T');
});

test('v2.4 stays v2.4, with its year in TDRC', async () => {
  const f = write('c.mp3', A.v24([['TIT2', A.utf8('Old ñ')], ['TDRC', A.latin('2001-05-02')], ['TSSE', A.latin('LAME')]]), A.AUDIO);
  assert.strictEqual((await readDetails(f)).year, '2001');
  await writeTags(f, { changes: { year: '2009', artist: 'Ñandú' } });
  const d = await readDetails(f);
  assert.strictEqual(fs.readFileSync(f)[3], 4);
  assert.strictEqual(d.year, '2009');
  assert.strictEqual(d.artist, 'Ñandú');
  assert.strictEqual(d.title, 'Old ñ');
  assert(frameIds(f).includes('TSSE'));
  assertAudioKept(f);
});

test('v2.2 with a PNG cover converts to v2.3', async () => {
  const pic = Buffer.concat([Buffer.from([0]), Buffer.from('PNG'), Buffer.from([3, 0]), A.PNG_BYTES]);
  const f = write('d.mp3', A.v22([['TT2', A.latin('Book')], ['TP1', A.latin('Author')], ['TAL', A.latin('Book — A Tale')], ['PIC', pic], ['TRK', A.latin('1')]]), A.AUDIO);
  await writeTags(f, { changes: { genre: 'Audiobook' } });
  const d = await readDetails(f);
  const b = fs.readFileSync(f);
  assert.strictEqual(b[3], 3);
  assert.strictEqual(d.title, 'Book');
  assert.strictEqual(d.artist, 'Author');
  assert.strictEqual(d.genre, 'Audiobook');
  assert(b.includes(Buffer.from('image/png')));
  assert(b.includes(A.PNG_BYTES));
  assertAudioKept(f);
});

test('a file with no tag gets one', async () => {
  const f = write('e.mp3', A.AUDIO);
  await writeTags(f, { changes: { title: 'Fresh', track: '2', trackTotal: '9' } });
  const d = await readDetails(f);
  assert.deepStrictEqual([d.title, d.track, d.trackTotal], ['Fresh', '2', '9']);
  assertAudioKept(f);
});

test('old ID3v1 tags go on any save', async () => {
  const f = write('f.mp3', A.v23([['TIT2', A.latin('T')]]), A.AUDIO, A.id3v1());
  await writeTags(f, { changes: { artist: 'A' } });
  const b = fs.readFileSync(f);
  assert.notStrictEqual(b.toString('latin1', b.length - 128, b.length - 125), 'TAG');
  assertAudioKept(f);
});

test('strip removes every tag, the cover and private data', async () => {
  const f = write('g.mp3', A.v23([['TIT2', A.latin('T')], ['TPE1', A.latin('A')], ['APIC', A.apic('image/jpeg', A.JPEG)], ['COMM', A.comm('private store account')], ['PRIV', Buffer.from('secret')], ['WOAF', Buffer.from('http://x')]]), A.AUDIO, A.apeBlock(), A.id3v1());
  await writeTags(f, { strip: true, changes: { title: 'Only This' } });
  const b = fs.readFileSync(f);
  assert.deepStrictEqual(frameIds(f), ['TIT2']);
  for (const gone of ['secret', 'private store', 'http://x', 'APETAGEX']) assert(!b.includes(Buffer.from(gone)), `still has ${gone}`);
  assert(!b.includes(A.JPEG));
  assert.strictEqual((await readDetails(f)).title, 'Only This');
  assert.strictEqual(b.length - A.tagEnd(b), A.AUDIO.length, 'exactly the audio is left');
  assertAudioKept(f);
});

test('a block of tags at the end survives a tweak', async () => {
  const f = write('h.mp3', A.v23([['TIT2', A.latin('T')]]), A.AUDIO, A.apeBlock(), A.id3v1());
  await writeTags(f, { changes: { artist: 'A' } });
  assert(fs.readFileSync(f).includes(Buffer.from('APETAGEX')));
  assertAudioKept(f);
});

test('strip can add a new cover in the same save', async () => {
  const f = write('i.mp3', A.v23([['TIT2', A.latin('T')], ['APIC', A.apic('image/jpeg', A.JPEG)]]), A.AUDIO);
  await writeTags(f, { strip: true, cover: A.PNG_BYTES });
  const b = fs.readFileSync(f);
  assert.deepStrictEqual(frameIds(f), ['APIC']);
  assert(b.includes(A.PNG_BYTES));
  assert(!b.includes(A.JPEG));
});

test('a cover can be added, replaced and removed', async () => {
  const f = write('j.mp3', A.v23([['TIT2', A.latin('T')]]), A.AUDIO);
  await writeTags(f, { cover: A.JPEG });
  assert((await readCover(f)).equals(A.JPEG));
  await writeTags(f, { cover: A.PNG_BYTES });
  assert((await readCover(f)).equals(A.PNG_BYTES));
  assert.strictEqual(frameIds(f).filter((i) => i === 'APIC').length, 1);
  await writeTags(f, { cover: null });
  assert.strictEqual(await readCover(f), null);
  assert.strictEqual((await readDetails(f)).title, 'T');
  assertAudioKept(f);
});

test('something that is not an image is refused, and the file is untouched', async () => {
  const f = write('k.mp3', A.v23([['TIT2', A.latin('T')]]), A.AUDIO);
  const original = A.sha(fs.readFileSync(f));
  await assert.rejects(writeTags(f, { cover: Buffer.from('not an image') }));
  assert.strictEqual(A.sha(fs.readFileSync(f)), original);
  assert.deepStrictEqual(leftovers(), []);
});

test('other formats are refused', async () => {
  const f = write('l.flac', A.AUDIO);
  await assert.rejects(writeTags(f, { changes: { title: 'x' } }));
  assert.strictEqual(A.sha(fs.readFileSync(f)), A.sha(A.AUDIO));
});

test('whole-tag unsynchronisation is undone', async () => {
  const tag = Buffer.concat([Buffer.from('TIT2'), Buffer.from([0, 0, 0, 5, 0, 0]), A.latin('Sync'), Buffer.from([0xff, 0x00, 0xe0])]);
  const f = write('m.mp3', Buffer.from('ID3'), Buffer.from([3, 0, 0x80]), A.syncsafe(tag.length), tag, A.AUDIO);
  await writeTags(f, { changes: { artist: 'A' } });
  const d = await readDetails(f);
  assert.strictEqual(d.artist, 'A');
  assert.strictEqual(d.title, 'Sync');
  assert.strictEqual(fs.readFileSync(f)[5], 0);
  assertAudioKept(f);
});

test('v2.4 frames encoded separately are decoded, as on real files', async () => {
  const pictureRaw = Buffer.concat([Buffer.from('\0image/jpeg\0\x03\0', 'latin1'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0x00, 0x11])]);
  const encoded = Buffer.concat([Buffer.from('\0image/jpeg\0\x03\0', 'latin1'), Buffer.from([0xff, 0x00, 0xd8, 0xff, 0x00, 0xe0, 0xff, 0x00, 0x00, 0x11])]);
  const frame = (id, data, flag) => Buffer.concat([Buffer.from(id), A.syncsafe(data.length), Buffer.from([0, flag]), data]);
  const body = Buffer.concat([
    frame('TIT2', Buffer.concat([A.syncsafe(6), A.utf8('Title')]), 0x01),
    frame('APIC', Buffer.concat([A.syncsafe(pictureRaw.length), encoded]), 0x03),
    frame('TALB', A.utf8('Plain'), 0),
  ]);
  const f = write('n.mp3', Buffer.from('ID3'), Buffer.from([4, 0, 0x80]), A.syncsafe(body.length), body, A.AUDIO, A.id3v1());
  const d = await readDetails(f);
  assert.strictEqual(d.title, 'Title');
  assert.strictEqual(d.album, 'Plain');
  await writeTags(f, { changes: { comment: 'x' } });
  assert(fs.readFileSync(f).includes(pictureRaw), 'cover decoded');
  assert.strictEqual((await readDetails(f)).title, 'Title');
  assertAudioKept(f);
});

test('disc, compilation and comment fields round-trip', async () => {
  const f = write('o.mp3', A.AUDIO);
  await writeTags(f, { changes: { disc: '2', discTotal: '3', compilation: true, comment: 'A note', composer: 'Björk', albumArtist: 'Various' } });
  let d = await readDetails(f);
  assert.deepStrictEqual([d.disc, d.discTotal, d.compilation, d.comment, d.composer, d.albumArtist], ['2', '3', true, 'A note', 'Björk', 'Various']);
  await writeTags(f, { changes: { compilation: false, discTotal: '' } });
  d = await readDetails(f);
  assert.strictEqual(d.compilation, false);
  assert.strictEqual(d.disc, '2');
  assert.strictEqual(d.discTotal, '');
});

test('a temporary file left by a crash does not block a save', async () => {
  const f = write('p.mp3', A.v23([['TIT2', A.latin('T')]]), A.AUDIO);
  fs.writeFileSync(path.join(dir, '.p.mp3.saving'), 'left over');
  await writeTags(f, { changes: { title: 'x' } });
  assert.strictEqual((await readDetails(f)).title, 'x');
  assert.deepStrictEqual(leftovers(), []);
});

test('a read-only folder fails cleanly and leaves the original intact', { skip: process.getuid && process.getuid() === 0 }, async () => {
  const locked = path.join(dir, 'locked');
  fs.mkdirSync(locked);
  const f = path.join(locked, 'q.mp3');
  fs.writeFileSync(f, Buffer.concat([A.v23([['TIT2', A.latin('T')]]), A.AUDIO]));
  const original = A.sha(fs.readFileSync(f));
  fs.chmodSync(locked, 0o555);
  try {
    await assert.rejects(writeTags(f, { changes: { title: 'x' } }));
  } finally {
    fs.chmodSync(locked, 0o755);
  }
  assert.strictEqual(A.sha(fs.readFileSync(f)), original);
});

test('progress is reported and file permissions are kept', async () => {
  const f = write('r.mp3', A.v23([['TIT2', A.latin('T')]]), A.AUDIO);
  fs.chmodSync(f, 0o640);
  let last = 0;
  await writeTags(f, { changes: { title: 'x' } }, (fraction) => { last = fraction; });
  assert.strictEqual(last, 1);
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o640);
});
