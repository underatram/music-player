// Reads music tags, durations and cover art: ID3v2, FLAC, Ogg Vorbis/Opus, MP4,
// MP3 and WAV. Only the bytes that are needed are read from each file. Embedded
// cover art is skipped without being loaded unless a cover is asked for.
const Tags = (() => {
  const MAX_TAG_BYTES = 64 * 1024 * 1024;
  const ID3_CHUNK_BYTES = 128 * 1024;
  const OGG_TAIL_BYTES = 64 * 1024;
  const MP3_SEARCH_BYTES = 8 * 1024;

  // The standard ID3 genre numbers, which older files store instead of names.
  const ID3_GENRES = [
    'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
    'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial',
    'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk',
    'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
    'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic',
    'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta',
    'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes',
    'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
  ];

  const bytes = async (file, start, end) =>
    new Uint8Array(await file.slice(start, end).arrayBuffer());
  const ascii = (b, start, end) => String.fromCharCode(...b.subarray(start, end));
  const u24be = (b, p) => (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
  const u32be = (b, p) => b[p] * 0x1000000 + u24be(b, p + 1);
  const u32le = (b, p) => b[p] + (b[p + 1] << 8) + (b[p + 2] << 16) + b[p + 3] * 0x1000000;
  const syncsafe = (b, p) => (b[p] << 21) | (b[p + 1] << 14) | (b[p + 2] << 7) | b[p + 3];

  const decoders = {};
  function decode(label, b) {
    decoders[label] = decoders[label] || new TextDecoder(label);
    return decoders[label].decode(b);
  }

  function setText(out, field, value) {
    const text = (value || '').trim();
    if (text && !out[field]) out[field] = text;
  }

  function setNumber(out, field, value) {
    const n = parseInt(value, 10);
    if (n > 0 && !out[field]) out[field] = n;
  }

  function setYear(out, value) {
    const match = /\d{4}/.exec(value || '');
    if (match && !out.year) out.year = Number(match[0]);
  }

  function setDuration(out, seconds) {
    if (Number.isFinite(seconds) && seconds > 0 && !out.duration) out.duration = seconds;
  }

  function imageType(mime) {
    const m = (mime || '').toLowerCase();
    return m === 'png' || m === 'image/png' ? 'image/png' : 'image/jpeg';
  }

  // Front covers (picture type 3) win over any other embedded image.
  function setCover(out, data, mime, pictureType) {
    if (out.cover && (out.coverIsFront || pictureType !== 3)) return;
    out.cover = new Blob([data], { type: imageType(mime) });
    out.coverIsFront = pictureType === 3;
  }

  // ---- ID3v2 ----

  const ID3_V22_FRAMES = {
    TT2: 'TIT2', TP1: 'TPE1', TP2: 'TPE2', TAL: 'TALB', TRK: 'TRCK',
    TPA: 'TPOS', TYE: 'TYER', TCP: 'TCMP', TCO: 'TCON', PIC: 'APIC',
  };
  const ID3_WANTED = new Set(['TIT2', 'TPE1', 'TPE2', 'TALB', 'TRCK', 'TPOS', 'TYER', 'TDRC', 'TCMP', 'TCON']);

  function removeUnsync(b) {
    const out = new Uint8Array(b.length);
    let n = 0;
    for (let i = 0; i < b.length; i++) {
      out[n++] = b[i];
      if (b[i] === 0xff && b[i + 1] === 0) i++;
    }
    return out.subarray(0, n);
  }

  function id3Values(body) {
    const enc = body[0];
    const data = body.subarray(1);
    let label = 'latin1';
    if (enc === 1) label = data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-16le';
    else if (enc === 2) label = 'utf-16be';
    else if (enc === 3) label = 'utf-8';
    return decode(label, data)
      .replace(/﻿/g, '')
      .split('\0')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Genres can be "Rock", "17", "(17)" or "(17)Rock".
  function id3Genre(value) {
    const match = /^\((\d+)\)(.*)$/.exec(value || '');
    if (match) return match[2].trim() || ID3_GENRES[Number(match[1])];
    if (/^\d+$/.test(value || '')) return ID3_GENRES[Number(value)];
    return value;
  }

  function applyId3Frame(id, body, out) {
    const values = id3Values(body);
    const text = values.join(', ');
    switch (id) {
      case 'TIT2': setText(out, 'title', text); break;
      case 'TPE1': setText(out, 'artist', text); break;
      case 'TPE2': setText(out, 'albumArtist', text); break;
      case 'TALB': setText(out, 'album', text); break;
      case 'TRCK':
        setNumber(out, 'trackNo', text);
        setNumber(out, 'trackTotal', text.split('/')[1]);
        break;
      case 'TPOS':
        setNumber(out, 'discNo', text);
        setNumber(out, 'discTotal', text.split('/')[1]);
        break;
      case 'TYER':
      case 'TDRC': setYear(out, text); break;
      case 'TCMP': out.compilation = text === '1'; break;
      case 'TCON': setText(out, 'genre', id3Genre(values[0])); break;
    }
  }

  function id3Picture(body, isV22, out) {
    const enc = body[0];
    let pos;
    let mime;
    if (isV22) {
      mime = ascii(body, 1, 4);
      pos = 4;
    } else {
      const end = body.indexOf(0, 1);
      if (end < 0) return;
      mime = ascii(body, 1, end);
      pos = end + 1;
    }
    const pictureType = body[pos++];
    if (enc === 1 || enc === 2) {
      while (pos + 1 < body.length && (body[pos] || body[pos + 1])) pos += 2;
      pos += 2;
    } else {
      while (pos < body.length && body[pos]) pos++;
      pos++;
    }
    if (pos < body.length) setCover(out, body.subarray(pos), mime, pictureType);
  }

  async function parseId3(file, head, out, wantCover) {
    const major = head[3];
    const flags = head[5];
    if (major < 2 || major > 4) return;

    let bodyLength = syncsafe(head, 6);
    let data;
    let base = 0;
    if (major < 4 && flags & 0x80) {
      if (bodyLength > MAX_TAG_BYTES) return;
      data = removeUnsync(await bytes(file, 10, 10 + bodyLength));
      bodyLength = data.length;
    } else {
      data = await bytes(file, 10, 10 + Math.min(bodyLength, ID3_CHUNK_BYTES));
    }
    const loadFrom = async (position) => {
      base = position;
      data = await bytes(file, 10 + position, 10 + Math.min(bodyLength, position + ID3_CHUNK_BYTES));
    };

    let pos = 0;
    if (major >= 3 && flags & 0x40) {
      pos = major === 4 ? syncsafe(data, 0) : u32be(data, 0) + 4;
    }

    const idLength = major === 2 ? 3 : 4;
    const headerLength = major === 2 ? 6 : 10;

    while (pos + headerLength <= bodyLength) {
      if (pos + headerLength > base + data.length) await loadFrom(pos);

      let at = pos - base;
      let id = ascii(data, at, at + idLength);
      if (!/^[A-Z0-9]+$/.test(id)) break;

      let size;
      if (major === 2) size = u24be(data, at + 3);
      else if (major === 3) size = u32be(data, at + 4);
      else size = syncsafe(data, at + 4);

      const frameStart = pos;
      const end = pos + headerLength + size;
      if (end > bodyLength) break;
      pos = end;

      if (major === 2) id = ID3_V22_FRAMES[id] || id;
      // Cover art and other large frames are stepped over unless a cover was asked for.
      const isPicture = wantCover && id === 'APIC' && size <= MAX_TAG_BYTES;
      if (!isPicture && (!ID3_WANTED.has(id) || !size || size > ID3_CHUNK_BYTES)) continue;

      if (end > base + data.length) {
        if (isPicture) {
          base = frameStart;
          data = await bytes(file, 10 + frameStart, 10 + end);
        } else {
          await loadFrom(frameStart);
        }
        at = 0;
      }

      let body = data.subarray(at + headerLength, at + headerLength + size);
      const frameFlags = major === 2 ? 0 : data[at + 9];
      if (major === 3) {
        if (frameFlags & 0xc0) continue; // compressed or encrypted
        if (frameFlags & 0x20) body = body.subarray(1);
      } else if (major === 4) {
        if (frameFlags & 0x0c) continue; // compressed or encrypted
        if (frameFlags & 0x40) body = body.subarray(1);
        if (frameFlags & 0x01) body = body.subarray(4);
        if (frameFlags & 0x02) body = removeUnsync(body);
      }
      if (body.length && isPicture) id3Picture(body, major === 2, out);
      else if (body.length) applyId3Frame(id, body, out);
    }
  }

  // ---- Vorbis comments (FLAC and Ogg) ----

  function flacPicture(b, out) {
    const pictureType = u32be(b, 0);
    const mimeLength = u32be(b, 4);
    const mime = ascii(b, 8, 8 + mimeLength);
    let pos = 8 + mimeLength;
    pos += 4 + u32be(b, pos); // description
    pos += 16; // width, height, depth, colours
    const length = u32be(b, pos);
    pos += 4;
    if (length && pos + length <= b.length) setCover(out, b.subarray(pos, pos + length), mime, pictureType);
  }

  function parseVorbisComments(b, out, wantCover) {
    let pos = 4 + u32le(b, 0); // vendor string
    const count = u32le(b, pos);
    pos += 4;
    const artists = [];

    for (let i = 0; i < count && pos + 4 <= b.length; i++) {
      const length = u32le(b, pos);
      pos += 4;
      const end = pos + length;
      if (end > b.length) break;

      const entry = b.subarray(pos, end);
      pos = end;
      const eq = entry.indexOf(0x3d);
      if (eq < 1) continue;
      const key = ascii(entry, 0, eq).toUpperCase();
      if (key === 'METADATA_BLOCK_PICTURE') {
        if (wantCover) {
          const raw = atob(decode('latin1', entry.subarray(eq + 1)));
          flacPicture(Uint8Array.from(raw, (c) => c.charCodeAt(0)), out);
        }
        continue;
      }

      const value = decode('utf-8', entry.subarray(eq + 1));
      switch (key) {
        case 'TITLE': setText(out, 'title', value); break;
        case 'ARTIST': artists.push(value.trim()); break;
        case 'ALBUMARTIST':
        case 'ALBUM ARTIST': setText(out, 'albumArtist', value); break;
        case 'ALBUM': setText(out, 'album', value); break;
        case 'GENRE': setText(out, 'genre', value); break;
        case 'TRACKNUMBER': setNumber(out, 'trackNo', value); break;
        case 'DISCNUMBER': setNumber(out, 'discNo', value); break;
        case 'DATE':
        case 'YEAR': setYear(out, value); break;
        case 'COMPILATION': out.compilation = value.trim() === '1'; break;
      }
    }
    setText(out, 'artist', artists.filter(Boolean).join(', '));
  }

  async function parseFlac(file, offset, out, wantCover) {
    let pos = offset + 4;
    for (let i = 0; i < 1000; i++) {
      const header = await bytes(file, pos, pos + 4);
      if (header.length < 4) return;
      const type = header[0] & 0x7f;
      const size = u24be(header, 1);
      const body = pos + 4;

      if (type === 0 && size >= 18) {
        const info = await bytes(file, body, body + 18);
        const rate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
        const samples = (info[13] & 0x0f) * 0x100000000 + u32be(info, 14);
        setDuration(out, samples / rate);
      } else if (type === 4 && size <= MAX_TAG_BYTES) {
        parseVorbisComments(await bytes(file, body, body + size), out, wantCover);
      } else if (type === 6 && wantCover && size <= MAX_TAG_BYTES) {
        flacPicture(await bytes(file, body, body + size), out);
      }
      if (header[0] & 0x80) return;
      pos = body + size;
    }
  }

  // Returns the second packet of the first Ogg stream (the comment packet), or
  // null if it doesn't fit in the bytes read so far.
  function oggCommentPacket(b) {
    let pos = 0;
    let serial = null;
    let packet = 0;
    const chunks = [];

    while (pos + 27 <= b.length) {
      if (ascii(b, pos, pos + 4) !== 'OggS') throw new Error('Invalid Ogg page');
      const segments = b[pos + 26];
      let dataPos = pos + 27 + segments;
      if (dataPos > b.length) return null;

      const pageSerial = u32le(b, pos + 14);
      if (serial === null) serial = pageSerial;

      for (let i = 0; i < segments; i++) {
        const length = b[pos + 27 + i];
        if (pageSerial === serial) {
          if (packet === 1) {
            if (dataPos + length > b.length) return null;
            chunks.push(b.subarray(dataPos, dataPos + length));
          }
          if (length < 255) {
            if (packet === 1) {
              const whole = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
              let written = 0;
              for (const chunk of chunks) {
                whole.set(chunk, written);
                written += chunk.length;
              }
              return whole;
            }
            packet++;
          }
        }
        dataPos += length;
      }
      pos = dataPos;
    }
    return null;
  }

  async function parseOggDuration(file, offset, out, first) {
    const ident = first.subarray(27 + first[26]);
    let rate = 0;
    let preSkip = 0;
    if (ascii(ident, 0, 8) === 'OpusHead') {
      rate = 48000;
      preSkip = ident[10] | (ident[11] << 8);
    } else if (ascii(ident, 0, 7) === '\x01vorbis') {
      rate = u32le(ident, 12);
    }
    if (!rate) return;

    const tail = await bytes(file, Math.max(offset, file.size - OGG_TAIL_BYTES), file.size);
    for (let i = tail.length - 14; i >= 0; i--) {
      if (tail[i] === 0x4f && ascii(tail, i, i + 4) === 'OggS') {
        const samples = u32le(tail, i + 10) * 0x100000000 + u32le(tail, i + 6);
        setDuration(out, (samples - preSkip) / rate);
        return;
      }
    }
  }

  async function parseOgg(file, offset, out, wantCover) {
    for (let size = 256 * 1024; size <= MAX_TAG_BYTES; size *= 4) {
      const first = await bytes(file, offset, offset + size);
      const packet = oggCommentPacket(first);
      if (packet) {
        if (ascii(packet, 0, 8) === 'OpusTags') parseVorbisComments(packet.subarray(8), out, wantCover);
        else if (ascii(packet, 0, 7) === '\x03vorbis') parseVorbisComments(packet.subarray(7), out, wantCover);
        await parseOggDuration(file, offset, out, first);
        return;
      }
      if (offset + size >= file.size) return;
    }
  }

  // ---- MP4 ----

  function mp4Child(b, name) {
    let pos = 0;
    while (pos + 8 <= b.length) {
      const size = u32be(b, pos);
      if (size < 8 || pos + size > b.length) return null;
      if (ascii(b, pos + 4, pos + 8) === name) return b.subarray(pos + 8, pos + size);
      pos += size;
    }
    return null;
  }

  function parseIlst(ilst, out, wantCover) {
    let pos = 0;
    while (pos + 8 <= ilst.length) {
      const size = u32be(ilst, pos);
      if (size < 8 || pos + size > ilst.length) return;
      const key = ascii(ilst, pos + 4, pos + 8);
      const data = mp4Child(ilst.subarray(pos + 8, pos + size), 'data');
      pos += size;
      if (!data || data.length < 8) continue;

      const value = data.subarray(8);
      const text = () => decode('utf-8', value);
      const pairFirst = () => (value.length >= 4 ? (value[2] << 8) | value[3] : 0);

      switch (key) {
        case '\xA9nam': setText(out, 'title', text()); break;
        case '\xA9ART': setText(out, 'artist', text()); break;
        case 'aART': setText(out, 'albumArtist', text()); break;
        case '\xA9alb': setText(out, 'album', text()); break;
        case '\xA9gen': setText(out, 'genre', text()); break;
        case 'gnre': setText(out, 'genre', ID3_GENRES[((value[0] << 8) | value[1]) - 1]); break;
        case '\xA9day': setYear(out, text()); break;
        case 'trkn': setNumber(out, 'trackNo', pairFirst()); break;
        case 'disk': setNumber(out, 'discNo', pairFirst()); break;
        case 'cpil': out.compilation = value[0] === 1; break;
        case 'covr':
          if (wantCover) setCover(out, value, u32be(data, 0) === 14 ? 'image/png' : 'image/jpeg', 3);
          break;
      }
    }
  }

  async function parseMp4(file, out, wantCover) {
    let pos = 0;
    while (pos + 8 <= file.size) {
      const header = await bytes(file, pos, pos + 16);
      let size = u32be(header, 0);
      let headerLength = 8;
      if (size === 1) {
        size = u32be(header, 8) * 0x100000000 + u32be(header, 12);
        headerLength = 16;
      } else if (size === 0) {
        size = file.size - pos;
      }
      if (size < headerLength) return;

      if (ascii(header, 4, 8) === 'moov') {
        if (size > MAX_TAG_BYTES) return;
        const moov = await bytes(file, pos + headerLength, pos + size);

        const mvhd = mp4Child(moov, 'mvhd');
        if (mvhd) {
          if (mvhd[0] === 1) {
            setDuration(out, (u32be(mvhd, 24) * 0x100000000 + u32be(mvhd, 28)) / u32be(mvhd, 20));
          } else {
            setDuration(out, u32be(mvhd, 16) / u32be(mvhd, 12));
          }
        }

        const udta = mp4Child(moov, 'udta');
        let meta = udta && mp4Child(udta, 'meta');
        if (!meta) return;
        // meta usually has a 4-byte version field, but not in QuickTime files.
        if (ascii(meta, 4, 8) !== 'hdlr') meta = meta.subarray(4);
        const ilst = mp4Child(meta, 'ilst');
        if (ilst) parseIlst(ilst, out, wantCover);
        return;
      }
      pos += size;
    }
  }

  // ---- Durations for formats with no duration field in their tags ----

  const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const MP3_RATES = [44100, 48000, 32000];

  async function parseMp3Duration(file, offset, out) {
    const b = await bytes(file, offset, offset + MP3_SEARCH_BYTES);
    for (let i = 0; i + 4 <= b.length; i++) {
      if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;

      const version = (b[i + 1] >> 3) & 3; // 3: MPEG1, 2: MPEG2, 0: MPEG2.5
      const layer = (b[i + 1] >> 1) & 3; // 1: Layer III
      const bitrateIndex = b[i + 2] >> 4;
      const rateIndex = (b[i + 2] >> 2) & 3;
      if (version === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15 || rateIndex === 3) continue;

      const isV1 = version === 3;
      const rate = MP3_RATES[rateIndex] / (isV1 ? 1 : version === 2 ? 2 : 4);
      const samplesPerFrame = isV1 ? 1152 : 576;
      const mono = b[i + 3] >> 6 === 3;
      const sideInfo = isV1 ? (mono ? 17 : 32) : (mono ? 9 : 17);

      // Variable bitrate files record their frame count in the first frame.
      const xing = i + 4 + sideInfo;
      const xingTag = ascii(b, xing, xing + 4);
      if ((xingTag === 'Xing' || xingTag === 'Info') && b[xing + 7] & 1) {
        setDuration(out, (u32be(b, xing + 8) * samplesPerFrame) / rate);
      } else if (ascii(b, i + 36, i + 40) === 'VBRI') {
        setDuration(out, (u32be(b, i + 50) * samplesPerFrame) / rate);
      } else {
        const bitrate = (isV1 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIndex] * 1000;
        setDuration(out, ((file.size - offset - i) * 8) / bitrate);
      }
      return;
    }
  }

  async function parseWavDuration(file, out) {
    let pos = 12;
    let byteRate = 0;
    for (let i = 0; i < 32 && pos + 8 <= file.size; i++) {
      const header = await bytes(file, pos, pos + 16);
      const id = ascii(header, 0, 4);
      const size = u32le(header, 4);
      if (id === 'fmt ') {
        byteRate = u32le(await bytes(file, pos + 8, pos + 24), 8);
      } else if (id === 'data') {
        if (byteRate) setDuration(out, size / byteRate);
        return;
      }
      pos += 8 + size + (size & 1);
    }
  }

  // ---- Entry point ----

  async function read(file, { cover = false } = {}) {
    const out = {};
    const head = await bytes(file, 0, 12);
    let offset = 0;

    if (ascii(head, 0, 3) === 'ID3') {
      const total = 10 + syncsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);
      await parseId3(file, head, out, cover);
      offset = total;
    }

    const start = offset ? await bytes(file, offset, offset + 12) : head;
    const magic = ascii(start, 0, 4);
    if (magic === 'fLaC') await parseFlac(file, offset, out, cover);
    else if (magic === 'OggS') await parseOgg(file, offset, out, cover);
    else if (ascii(start, 4, 8) === 'ftyp') await parseMp4(file, out, cover);
    else if (magic === 'RIFF') await parseWavDuration(file, out);
    else if (/\.mp3$/i.test(file.name)) await parseMp3Duration(file, offset, out);
    return out;
  }

  return { read };
})();
