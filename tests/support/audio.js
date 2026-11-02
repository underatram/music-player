// Builds made-up MP3 files and tags for the tests.
const crypto = require('node:crypto');

// Silent MPEG-1 Layer III frames, which real players can decode.
const FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]);
const silence = (frames = 400) => Buffer.concat(Array.from({ length: frames }, () => FRAME));
const AUDIO = silence();

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(5000)]);
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(3000)]);
// A real 1x1 image, for code that actually decodes it.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

const syncsafe = (n) => Buffer.from([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);
const utf16 = (s) => Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
const utf8 = (s) => Buffer.concat([Buffer.from([3]), Buffer.from(s, 'utf8')]);
const latin = (s) => Buffer.concat([Buffer.from([0]), Buffer.from(s, 'latin1')]);

function v23(frames, padding = 200) {
  const body = Buffer.concat(frames.map(([id, data]) => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    return Buffer.concat([Buffer.from(id), size, Buffer.alloc(2), data]);
  }).concat(Buffer.alloc(padding)));
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), syncsafe(body.length), body]);
}

function v24(frames, padding = 200) {
  const body = Buffer.concat(frames.map(([id, data]) => Buffer.concat([Buffer.from(id), syncsafe(data.length), Buffer.alloc(2), data])).concat(Buffer.alloc(padding)));
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0]), syncsafe(body.length), body]);
}

function v22(frames) {
  const body = Buffer.concat(frames.map(([id, data]) => {
    const size = Buffer.alloc(3);
    size.writeUIntBE(data.length, 0, 3);
    return Buffer.concat([Buffer.from(id), size, data]);
  }));
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([2, 0, 0]), syncsafe(body.length), body]);
}

const apic = (mime, data) => Buffer.concat([Buffer.from(`\0${mime}\0\x03\0`, 'latin1'), data]);
const comm = (text, description = '') => Buffer.concat([Buffer.from([0]), Buffer.from('eng'), Buffer.from(description, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]);

function id3v1() {
  const tag = Buffer.alloc(128);
  tag.write('TAG');
  tag.write('Old Title', 3);
  return tag;
}

function apeBlock() {
  const piece = () => {
    const b = Buffer.alloc(32);
    b.write('APETAGEX');
    b.writeUInt32LE(2000, 8);
    b.writeUInt32LE(88, 12);
    b.writeUInt32LE(0x80000000, 20);
    return b;
  };
  return Buffer.concat([piece(), Buffer.alloc(56, 7), piece()]);
}

const tagEnd = (b) => (b.toString('latin1', 0, 3) === 'ID3' ? 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]) : 0);

// A tagged song, as a real library would have it.
function song({ title, artist = 'Test Artist', album = 'Test Album', genre = 'Rock', year = 2001, track = '1', extra = [], frames = 400 }) {
  const list = [['TIT2', utf16(title)], ['TPE1', utf16(artist)], ['TALB', utf16(album)], ['TCON', utf16(genre)], ['TYER', utf16(String(year))], ['TRCK', utf16(track)], ...extra];
  return Buffer.concat([v23(list), silence(frames)]);
}

module.exports = { AUDIO, JPEG, PNG_BYTES, TINY_PNG, sha, silence, syncsafe, utf16, utf8, latin, v22, v23, v24, apic, comm, id3v1, apeBlock, tagEnd, song };
