// Reads and rewrites the tags in MP3 files. A save builds a complete new copy
// beside the original and only replaces it once that copy has been checked, so a
// failure at any point leaves the original exactly as it was.
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const HEADER_BYTES = 10;
const ID3V1_BYTES = 128;
const APE_FOOTER_BYTES = 32;
const PADDING_BYTES = 1024;
const CHECK_BYTES = 64 * 1024;
const SYNCSAFE_LIMIT = 0x0fffffff;

// ID3v2.2 is converted on saving. Frames with no modern name are dropped.
const V22_FRAMES = {
  TT2: 'TIT2', TP1: 'TPE1', TP2: 'TPE2', TAL: 'TALB', TRK: 'TRCK', TPA: 'TPOS', TYE: 'TYER',
  TCP: 'TCMP', TCO: 'TCON', TCM: 'TCOM', COM: 'COMM', ULT: 'USLT', TS2: 'TSO2', TSA: 'TSOA',
  TSP: 'TSOP', TST: 'TSOT', TSC: 'TSOC', TBP: 'TBPM', TXX: 'TXXX', PIC: 'APIC',
};
const PICTURE_TYPES = { JPG: 'image/jpeg', PNG: 'image/png' };

const TEXT_FIELDS = { title: 'TIT2', artist: 'TPE1', albumArtist: 'TPE2', album: 'TALB', genre: 'TCON', composer: 'TCOM' };

const syncsafe = (b, at) => (b[at] << 21) | (b[at + 1] << 14) | (b[at + 2] << 7) | b[at + 3];

function toSyncsafe(n) {
  return Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);
}

function removeUnsync(b) {
  const out = Buffer.alloc(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0) i++;
  }
  return out.subarray(0, n);
}

const isFrameId = (b, at, length) => /^[A-Z0-9]+$/.test(b.toString('latin1', at, at + length));

function v22Picture(body) {
  const mime = PICTURE_TYPES[body.toString('latin1', 1, 4).toUpperCase()] || 'image/jpeg';
  return Buffer.concat([body.subarray(0, 1), Buffer.from(`${mime}\0`, 'latin1'), body.subarray(4)]);
}

// v2.4 sizes should be syncsafe, but some software writes plain numbers. The
// right reading is the one that lands on another frame or the end of the tag.
function v24FrameSize(b, at) {
  const size = syncsafe(b, at + 4);
  if (size < 0x80) return size;
  const next = at + HEADER_BYTES + size;
  if (next === b.length || b[next] === 0 || isFrameId(b, next, 4)) return size;
  return b.readUInt32BE(at + 4);
}

function parseFrames(body, major) {
  const frames = [];
  const idLength = major === 2 ? 3 : 4;
  const headerLength = major === 2 ? 6 : HEADER_BYTES;
  let at = 0;
  while (at + headerLength <= body.length && isFrameId(body, at, idLength)) {
    let id = body.toString('latin1', at, at + idLength);
    let size;
    if (major === 2) size = body.readUIntBE(at + 3, 3);
    else if (major === 3) size = body.readUInt32BE(at + 4);
    else size = v24FrameSize(body, at);
    const end = at + headerLength + size;
    if (end > body.length) break;
    let data = body.subarray(at + headerLength, end);
    let flags = major === 2 ? Buffer.alloc(2) : Buffer.from(body.subarray(at + 8, at + 10));
    at = end;
    // v2.4 can encode each frame separately. Undoing that makes it plain data
    // again; compressed, encrypted or grouped frames are carried across untouched.
    if (major === 4 && flags[1] & 0x03 && !(flags[1] & 0x4c)) {
      if (flags[1] & 0x01) data = data.subarray(4);
      if (flags[1] & 0x02) data = removeUnsync(data);
      flags = Buffer.from([flags[0], flags[1] & ~0x03]);
    }
    if (major === 2) {
      if (id === 'PIC') data = v22Picture(data);
      id = V22_FRAMES[id];
      if (!id) continue;
    }
    frames.push({ id, flags, data });
  }
  return frames;
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

// Where the tag ends and the audio begins, plus the frames that were in it.
async function readTag(handle) {
  const head = await readAt(handle, 0, HEADER_BYTES);
  if (head.length < HEADER_BYTES || head.toString('latin1', 0, 3) !== 'ID3') {
    return { major: null, audioStart: 0, frames: [] };
  }
  const major = head[3];
  const flags = head[5];
  const length = syncsafe(head, 6);
  const audioStart = HEADER_BYTES + length + (major === 4 && flags & 0x10 ? HEADER_BYTES : 0);
  if (major < 2 || major > 4) return { major: null, audioStart, frames: [] };

  let body = await readAt(handle, HEADER_BYTES, length);
  if (major < 4 && flags & 0x80) body = removeUnsync(body);
  if (major >= 3 && flags & 0x40) {
    const extended = major === 4 ? syncsafe(body, 0) : body.readUInt32BE(0) + 4;
    body = body.subarray(extended);
  }
  return { major, audioStart, frames: parseFrames(body, major) };
}

function decodeText(data) {
  const encoding = data[0];
  const raw = data.subarray(1);
  let text;
  if (encoding === 0) text = raw.toString('latin1');
  else if (encoding === 3) text = raw.toString('utf8');
  else {
    let swapped = Buffer.from(raw);
    let bytes = swapped;
    if (encoding === 2 || (swapped[0] === 0xfe && swapped[1] === 0xff)) {
      if (swapped.length % 2) swapped = swapped.subarray(0, swapped.length - 1);
      bytes = Buffer.from(swapped).swap16();
    }
    text = bytes.toString('utf16le').replace(/^﻿/, '');
  }
  return text.split('\0').filter(Boolean).join(', ').trim();
}

function encodeText(text, major) {
  const clean = text.replace(/\0/g, ' ');
  if (major === 4) return Buffer.concat([Buffer.from([3]), Buffer.from(clean, 'utf8')]);
  return Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(clean, 'utf16le')]);
}

// The comment frame is: encoding, language, description, nul, text.
function splitComment(data) {
  const encoding = data[0];
  const wide = encoding === 1 || encoding === 2;
  let at = 4;
  if (wide) {
    while (at + 1 < data.length && (data[at] || data[at + 1])) at += 2;
    at += 2;
  } else {
    while (at < data.length && data[at]) at++;
    at += 1;
  }
  const description = decodeText(Buffer.concat([data.subarray(0, 1), data.subarray(4, Math.max(4, at - (wide ? 2 : 1)))]));
  return { description, text: decodeText(Buffer.concat([data.subarray(0, 1), data.subarray(at)])) };
}

function encodeComment(text, major) {
  const encoded = encodeText(text, major);
  const terminator = major === 4 ? Buffer.from([0]) : Buffer.from([0xff, 0xfe, 0, 0]);
  return Buffer.concat([encoded.subarray(0, 1), Buffer.from('eng', 'latin1'), terminator, encoded.subarray(1)]);
}

// Compressed or encrypted frames can't be read, only kept. Their flag bits differ
// by version, but both versions' bits are never set on a frame we decoded.
const isOpaque = (frame) => Boolean(frame.flags[1] & 0xcc);

function pair(text) {
  const [number = '', total = ''] = (text || '').split('/');
  return { number: number.trim(), total: total.trim() };
}

function detailsFrom(frames) {
  const text = (...ids) => {
    const frame = frames.find((f) => ids.includes(f.id) && !isOpaque(f));
    return frame && frame.data.length ? decodeText(frame.data) : '';
  };
  const track = pair(text('TRCK'));
  const disc = pair(text('TPOS'));
  const comment = frames.filter((f) => f.id === 'COMM' && !isOpaque(f)).map((f) => splitComment(f.data)).find((c) => !c.description);
  return {
    title: text('TIT2'),
    artist: text('TPE1'),
    albumArtist: text('TPE2'),
    album: text('TALB'),
    genre: text('TCON'),
    composer: text('TCOM'),
    year: (text('TYER', 'TDRC').match(/\d{4}/) || [''])[0],
    track: track.number,
    trackTotal: track.total,
    disc: disc.number,
    discTotal: disc.total,
    compilation: text('TCMP') === '1',
    comment: comment ? comment.text : '',
  };
}

async function readDetails(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    return detailsFrom((await readTag(handle)).frames);
  } finally {
    await handle.close();
  }
}

// The embedded cover as image bytes, or null. Prefers the front cover.
async function readCover(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const pictures = (await readTag(handle)).frames.filter((f) => f.id === 'APIC' && !isOpaque(f));
    for (const { data } of pictures.sort((a, b) => Number(pictureType(b) === 3) - Number(pictureType(a) === 3))) {
      const image = pictureData(data);
      if (image && imageType(image)) return image;
    }
    return null;
  } finally {
    await handle.close();
  }
}

function pictureType(data) {
  return data[data.indexOf(0, 1) + 1];
}

// Picture frames are: encoding, type, nul, picture kind, description, nul, image.
function pictureData(data) {
  const wide = data[0] === 1 || data[0] === 2;
  let at = data.indexOf(0, 1) + 2;
  if (at < 2) return null;
  if (wide) {
    while (at + 1 < data.length && (data[at] || data[at + 1])) at += 2;
    at += 2;
  } else {
    while (at < data.length && data[at]) at++;
    at += 1;
  }
  return data.subarray(at);
}

function imageType(data) {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data[0] === 0x89 && data.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  return null;
}

function applyChanges(frames, changes, cover, major) {
  let next = [...frames];
  const old = detailsFrom(frames);
  const set = (id, data, also = []) => {
    next = next.filter((f) => f.id !== id && !also.includes(f.id));
    if (data) next.push({ id, flags: Buffer.alloc(2), data });
  };
  const setText = (id, value, also) => set(id, value ? encodeText(value, major) : null, also);

  for (const [field, id] of Object.entries(TEXT_FIELDS)) {
    if (changes[field] !== undefined) setText(id, changes[field]);
  }
  if (changes.year !== undefined) {
    if (major === 4) setText('TDRC', changes.year, ['TYER', 'TDAT']);
    else setText('TYER', changes.year, ['TDRC', 'TDAT']);
  }
  for (const [id, number, total] of [['TRCK', 'track', 'trackTotal'], ['TPOS', 'disc', 'discTotal']]) {
    if (changes[number] === undefined && changes[total] === undefined) continue;
    const n = changes[number] !== undefined ? changes[number] : old[number];
    const of = changes[total] !== undefined ? changes[total] : old[total];
    setText(id, n ? `${n}${of ? `/${of}` : ''}` : '');
  }
  if (changes.compilation !== undefined) setText('TCMP', changes.compilation ? '1' : '');
  if (changes.comment !== undefined) {
    next = next.filter((f) => f.id !== 'COMM' || isOpaque(f) || splitComment(f.data).description);
    if (changes.comment) next.push({ id: 'COMM', flags: Buffer.alloc(2), data: encodeComment(changes.comment, major) });
  }
  if (cover === null) next = next.filter((f) => f.id !== 'APIC');
  if (cover) {
    next = next.filter((f) => f.id !== 'APIC');
    const data = Buffer.from(cover);
    const type = imageType(data);
    if (!type) throw new Error('The cover must be a JPEG or PNG image.');
    const head = Buffer.from(`\0${type}\0\x03\0`, 'latin1');
    next.unshift({ id: 'APIC', flags: Buffer.alloc(2), data: Buffer.concat([head, data]) });
  }
  return next;
}

function buildTag(frames, major) {
  const parts = frames.map(({ id, flags, data }) => {
    const size = Buffer.alloc(4);
    if (major === 4) toSyncsafe(data.length).copy(size);
    else size.writeUInt32BE(data.length);
    return Buffer.concat([Buffer.from(id, 'latin1'), size, flags, data]);
  });
  const body = Buffer.concat([...parts, Buffer.alloc(PADDING_BYTES)]);
  if (body.length > SYNCSAFE_LIMIT) throw new Error('These tags are too large to save.');
  const head = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, major, 0, 0]), toSyncsafe(body.length)]);
  return Buffer.concat([head, body]);
}

// Old-style tags at the end of a file can disagree with the new ones, so they
// always go. APE tags only go on a strip, since they might hold anything.
async function audioEnd(handle, size, audioStart, strip) {
  let end = size;
  if (end - audioStart >= ID3V1_BYTES) {
    const tail = await readAt(handle, end - ID3V1_BYTES, 3);
    if (tail.toString('latin1') === 'TAG') end -= ID3V1_BYTES;
  }
  if (strip && end - audioStart >= APE_FOOTER_BYTES) {
    const footer = await readAt(handle, end - APE_FOOTER_BYTES, APE_FOOTER_BYTES);
    if (footer.toString('latin1', 0, 8) === 'APETAGEX') {
      const length = footer.readUInt32LE(12);
      const hasHeader = footer.readUInt32LE(20) & 0x80000000;
      const whole = length + (hasHeader ? APE_FOOTER_BYTES : 0);
      if (end - whole >= audioStart) end -= whole;
    }
  }
  return end;
}

function progressCounter(total, onProgress) {
  let done = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      done += chunk.length;
      onProgress(total ? done / total : 1);
      callback(null, chunk);
    },
  });
}

// request: { changes, strip, cover } where changes holds only the fields to set
// (an empty string removes one), and cover is image bytes, null to remove it, or
// left out to keep it. Everything else in the tag is kept unless strip is true.
async function writeTags(filePath, { changes = {}, strip = false, cover } = {}, onProgress = () => {}) {
  if (path.extname(filePath).toLowerCase() !== '.mp3') throw new Error('Only MP3 files can be edited.');

  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.saving`);
  const source = await fs.promises.open(filePath, 'r');
  let sourceClosed = false;
  try {
    const { size, mode } = await source.stat();
    const tag = await readTag(source);
    const major = tag.major === 4 ? 4 : 3;
    const frames = applyChanges(strip ? [] : tag.frames, changes, strip && cover === undefined ? null : cover, major);
    const end = await audioEnd(source, size, tag.audioStart, strip);
    if (end <= tag.audioStart) throw new Error('This file has no audio in it.');
    const newTag = buildTag(frames, major);
    const audioLength = end - tag.audioStart;
    const firstAudio = await readAt(source, tag.audioStart, Math.min(CHECK_BYTES, audioLength));

    // Only this app makes these files, so one left here is from a crash.
    await fs.promises.rm(temporary, { force: true });
    const output = await fs.promises.open(temporary, 'wx', mode);
    try {
      await output.write(newTag);
      await pipeline(
        fs.createReadStream(null, { fd: source.fd, autoClose: false, start: tag.audioStart, end: end - 1 }),
        progressCounter(audioLength, onProgress),
        fs.createWriteStream(null, { fd: output.fd, autoClose: false, start: newTag.length }),
      );
      await output.sync();
    } finally {
      await output.close();
    }

    // Replace the original only once the copy reads back as it should.
    const written = await fs.promises.open(temporary, 'r');
    try {
      const { size: writtenSize } = await written.stat();
      if (writtenSize !== newTag.length + audioLength) throw new Error('The saved copy is the wrong size.');
      const check = await readTag(written);
      if (check.audioStart !== newTag.length) throw new Error('The saved copy has a damaged tag.');
      if (!(await readAt(written, newTag.length, firstAudio.length)).equals(firstAudio)) {
        throw new Error('The saved copy has different audio.');
      }
    } finally {
      await written.close();
    }

    await source.close();
    sourceClosed = true;
    await fs.promises.rename(temporary, filePath);
    const stats = await fs.promises.stat(filePath);
    return { size: stats.size, lastModified: stats.mtimeMs };
  } catch (err) {
    await fs.promises.rm(temporary, { force: true });
    throw err;
  } finally {
    if (!sourceClosed) await source.close();
  }
}

module.exports = { readDetails, readCover, writeTags, imageType };
