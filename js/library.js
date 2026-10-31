// Turns picked files into tracks, then groups, filters and searches them.
const Library = (() => {
  const AUDIO_EXTENSIONS = /\.(mp3|flac|ogg|oga|opus|m4a|aac|wav)$/i;
  const CONCURRENT_READS = 8;
  const UPDATE_INTERVAL_MS = 200;
  const CACHE_VERSION = 'v3';
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  const META_FIELDS = [
    'title', 'artist', 'albumArtist', 'album', 'genre', 'trackNo', 'trackTotal', 'discNo', 'discTotal', 'year', 'compilation', 'duration',
  ];

  let tracks = [];
  let index = null;
  let currentRun = 0;
  let nextId = 1;

  const isAudio = (name) => AUDIO_EXTENSIONS.test(name);
  const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  // "The Antlers" sorts under A.
  const sortName = (name) => name.replace(/^the\s+/i, '');

  // Used when a file has no tags: Genre (12)/Artist/[1997] Album/01 Title.mp3
  function metaFromPath(path) {
    const parts = path.split('/');
    const name = parts[parts.length - 1].replace(/\.[^.]+$/, '');
    const numbered = /^(\d{1,3})[\s._-]+(.+)$/.exec(name);
    const albumFolder = parts.length >= 3 ? parts[parts.length - 2] : 'Unknown Album';
    const dated = /^\[(\d{4})\]\s*(.+)$/.exec(albumFolder);
    const genreFolder = parts.length >= 5 ? /^(.+) \(\d+\)$/.exec(parts[parts.length - 4]) : null;
    return {
      title: numbered ? numbered[2] : name,
      trackNo: numbered ? Number(numbered[1]) : null,
      album: dated ? dated[2] : albumFolder,
      year: dated ? Number(dated[1]) : null,
      artist: parts.length >= 4 ? parts[parts.length - 3] : 'Unknown Artist',
      genre: genreFolder ? genreFolder[1] : null,
    };
  }

  async function readMeta(entry) {
    const { file, path } = entry;
    const cacheKey = `${CACHE_VERSION}|${path}|${file.size}|${file.lastModified}`;
    const cached = await DB.get('tags', cacheKey);
    if (cached) return { meta: cached, cacheKey, fromCache: true };

    let tags = {};
    let readOk = true;
    try {
      tags = await Tags.read(file);
    } catch (err) {
      readOk = false;
      console.warn(`Could not read tags from ${path}`, err);
    }
    const fallback = metaFromPath(path);
    const meta = {
      title: tags.title || fallback.title,
      artist: tags.artist || tags.albumArtist || fallback.artist,
      albumArtist: tags.albumArtist || null,
      album: tags.album || fallback.album,
      genre: tags.genre || fallback.genre,
      trackNo: tags.trackNo || fallback.trackNo,
      trackTotal: tags.trackTotal || null,
      discNo: tags.discNo || null,
      discTotal: tags.discTotal || null,
      year: tags.year || fallback.year,
      compilation: Boolean(tags.compilation),
      duration: tags.duration || null,
    };
    // A failed read might just mean a drive was unplugged, so try again next time.
    if (readOk) await DB.put('tags', cacheKey, meta);
    return { meta, cacheKey, fromCache: false };
  }

  // What favourites, play counts and playlists know a song by.
  const keyFor = (meta) => fold(`${meta.artist}\0${meta.album}\0${meta.discNo || 1}\0${meta.trackNo || 0}\0${meta.title}`);

  function makeTrack(entry, meta, cacheKey, id = nextId++) {
    const groupArtist = meta.albumArtist || (meta.compilation ? 'Various Artists' : meta.artist);
    const artistKey = fold(groupArtist);
    return {
      ...meta,
      id,
      file: entry.file,
      path: entry.path,
      cacheKey,
      groupArtist,
      artistKey,
      key: keyFor(meta),
      artistSort: sortName(meta.artist),
      groupSort: sortName(groupArtist),
      albumKey: `${artistKey}\0${fold(meta.album)}`,
      genreKey: meta.genre ? fold(meta.genre) : '',
      yearKey: meta.year || 0,
      searchText: fold(`${meta.title} ${meta.artist} ${groupArtist} ${meta.album}`),
    };
  }

  // Artist, then the album's year, then disc and track.
  function compareTracks(a, b) {
    return (
      collator.compare(a.groupSort, b.groupSort) ||
      (a.albumYear || 9999) - (b.albumYear || 9999) ||
      collator.compare(a.album, b.album) ||
      (a.discNo || 1) - (b.discNo || 1) ||
      (a.trackNo || 9999) - (b.trackNo || 9999) ||
      collator.compare(a.title, b.title)
    );
  }

  function getIndex() {
    if (index) return index;
    // An album sorts by its earliest year, even if its tracks' years differ.
    const albumYears = new Map();
    for (const track of tracks) {
      const known = albumYears.get(track.albumKey);
      if (track.year && (!known || track.year < known)) albumYears.set(track.albumKey, track.year);
    }
    for (const track of tracks) track.albumYear = albumYears.get(track.albumKey) || null;

    const sorted = [...tracks].sort(compareTracks);
    index = { tracks: sorted, byKey: new Map(sorted.map((t) => [t.key, t])) };
    return index;
  }

  const byLabel = (a, b) => collator.compare(a.label, b.label);
  // Entries with no value, such as "Unknown Genre", go last.
  const unknownLast = (compare) => (a, b) => Boolean(b.value) - Boolean(a.value) || compare(a, b);

  // What each sidebar list groups by. Artists and albums keep the library's own
  // order, which is already artist, then album year.
  const FACETS = {
    artist: { key: 'artistKey', label: (t) => t.groupArtist },
    album: { key: 'albumKey', label: (t) => t.album },
    genre: { key: 'genreKey', label: (t) => t.genre || 'Unknown Genre', sort: unknownLast(byLabel) },
    year: {
      key: 'yearKey',
      label: (t) => (t.year ? String(t.year) : 'Unknown Year'),
      sort: unknownLast((a, b) => b.value - a.value),
    },
  };

  // Tracks matching a sidebar path: [{ field, value }, ...].
  function within(path, trackList = getIndex().tracks) {
    return path.reduce(
      (list, step) => list.filter((t) => t[FACETS[step.field].key] === step.value),
      trackList
    );
  }

  // The distinct values of a field across some tracks, with each one's tracks.
  function groups(field, trackList, { byName = false } = {}) {
    const facet = FACETS[field];
    const found = new Map();
    for (const track of trackList) {
      const value = track[facet.key];
      if (!found.has(value)) found.set(value, { value, label: facet.label(track), tracks: [] });
      found.get(value).tracks.push(track);
    }
    const list = [...found.values()];
    if (byName) return list.sort(byLabel);
    return facet.sort ? list.sort(facet.sort) : list;
  }

  // entries: [{ file, path }]. Calls onUpdate as tracks arrive. With keepCurrent,
  // the current library stays in place until the new one is ready, and songs
  // that are still there keep their ids so what's playing stays highlighted.
  async function ingest(entries, onUpdate = () => {}, { keepCurrent = false } = {}) {
    const run = ++currentRun;
    const todo = entries.filter(
      (e) => isAudio(e.path) && !e.path.split('/').some((part) => part.startsWith('.'))
    );
    const stats = { total: todo.length, done: 0, fromCache: 0 };
    const previousIds = new Map(keepCurrent ? tracks.map((t) => [t.path, t.id]) : []);
    const incoming = keepCurrent ? [] : tracks = [];
    index = null;
    onUpdate(stats);

    let cursor = 0;
    let lastUpdate = 0;
    const worker = async () => {
      while (cursor < todo.length && run === currentRun) {
        const entry = todo[cursor++];
        const { meta, cacheKey, fromCache } = await readMeta(entry);
        if (run !== currentRun) return;

        incoming.push(makeTrack(entry, meta, cacheKey, previousIds.get(entry.path)));
        if (!keepCurrent) index = null;
        stats.done++;
        if (fromCache) stats.fromCache++;
        if (Date.now() - lastUpdate >= UPDATE_INTERVAL_MS) {
          lastUpdate = Date.now();
          onUpdate(stats);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENT_READS }, worker));

    if (run === currentRun) {
      if (keepCurrent) {
        tracks = incoming;
        index = null;
      }
      onUpdate(stats);
    }
    return { ...stats, cancelled: run !== currentRun };
  }

  // A plain copy of the library that can be saved and restored later.
  function exportTracks() {
    return tracks.map((track) => {
      const meta = {};
      for (const field of META_FIELDS) meta[field] = track[field];
      return { file: track.file, path: track.path, cacheKey: track.cacheKey, meta };
    });
  }

  function restore(items) {
    currentRun++;
    tracks = items.map((item) => makeTrack(item, item.meta, item.cacheKey));
    index = null;
  }

  function search(query) {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    return getIndex().tracks.filter((t) => terms.every((term) => t.searchText.includes(term)));
  }

  // The key a file's tags give it now, for after it has been edited.
  async function keyFromFile(entry) {
    const { meta } = await readMeta(entry);
    return keyFor(meta);
  }

  function setDuration(track, seconds) {
    if (!Number.isFinite(seconds) || track.duration === seconds) return;
    track.duration = seconds;
    const meta = {};
    for (const field of META_FIELDS) meta[field] = track[field];
    DB.put('tags', track.cacheKey, meta);
  }

  return {
    ingest,
    exportTracks,
    restore,
    search,
    keyFromFile,
    keyFor,
    fold,
    setDuration,
    isAudio,
    compareText: (a, b) => collator.compare(a, b),
    get tracks() { return getIndex().tracks; },
    byKey: (key) => getIndex().byKey.get(key),
    within,
    groups,
  };
})();
