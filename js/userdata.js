// What can't be rebuilt by rescanning: favourites, play history, saved positions,
// per-song settings and playlists. Songs are identified by their tags rather
// than their path, so moving a file doesn't lose its data.
const UserData = (() => {
  const SAVE_DELAY_MS = 1000;
  // Long listens default to remembering their place and staying out of shuffle.
  const LONG_LISTEN_GENRES = new Set(['podcast', 'audiobook']);

  let data = { version: 1, songs: {}, playlists: [] };
  let saveTimer = null;
  let nextPlaylistId = 1;

  async function load() {
    const saved = Host ? await Host.readData() : await DB.get('kv', 'userData');
    if (saved && saved.songs && Array.isArray(saved.playlists)) data = saved;
    for (const playlist of data.playlists) {
      nextPlaylistId = Math.max(nextPlaylistId, Number(playlist.id.slice(1)) + 1);
    }
  }

  function writeNow() {
    saveTimer = null;
    if (Host) Host.writeData(data);
    else DB.put('kv', 'userData', data);
  }

  function save() {
    if (!saveTimer) saveTimer = setTimeout(writeNow, SAVE_DELAY_MS);
  }

  // Called as the app closes, when there's no time to wait for a normal save.
  function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    if (Host) Host.writeDataNow(data);
    else DB.put('kv', 'userData', data);
  }

  const song = (track) => data.songs[track.key] || {};

  function update(track, changes) {
    const next = { ...song(track), ...changes };
    if (!next.favourite) delete next.favourite;
    if (!next.position) delete next.position;
    if (Object.keys(next).length) data.songs[track.key] = next;
    else delete data.songs[track.key];
    save();
  }

  const isLongListen = (track) => LONG_LISTEN_GENRES.has(track.genreKey);
  const orDefault = (value, fallback) => (value === undefined ? fallback : value);

  // ---- Playlists ----

  const findPlaylist = (id) => data.playlists.find((p) => p.id === id);

  function createPlaylist(name) {
    const playlist = { id: `p${nextPlaylistId++}`, name, songs: [] };
    data.playlists.push(playlist);
    save();
    return playlist;
  }

  function renamePlaylist(id, name) {
    findPlaylist(id).name = name;
    save();
  }

  function deletePlaylist(id) {
    data.playlists = data.playlists.filter((p) => p.id !== id);
    save();
  }

  // Returns how many were new; a song only appears once in a playlist.
  function addToPlaylist(id, tracks) {
    const playlist = findPlaylist(id);
    const existing = new Set(playlist.songs);
    const added = [];
    for (const { key } of tracks) {
      if (!existing.has(key)) {
        existing.add(key);
        added.push(key);
      }
    }
    playlist.songs.push(...added);
    save();
    return added.length;
  }

  function removeFromPlaylist(id, track) {
    const playlist = findPlaylist(id);
    playlist.songs = playlist.songs.filter((key) => key !== track.key);
    save();
  }

  // Songs not in the current library (an unplugged drive, say) keep their place at the end.
  function setPlaylistOrder(id, tracks) {
    const playlist = findPlaylist(id);
    const shown = new Set(tracks.map((t) => t.key));
    playlist.songs = [...tracks.map((t) => t.key), ...playlist.songs.filter((key) => !shown.has(key))];
    save();
  }

  return {
    load,
    flush,
    isFavourite: (track) => Boolean(song(track).favourite),
    toggleFavourite: (track) => update(track, { favourite: !song(track).favourite }),
    setFavourite: (track, on) => update(track, { favourite: on }),
    plays: (track) => song(track).plays || 0,
    countPlay: (track) => update(track, { plays: (song(track).plays || 0) + 1, lastPlayed: Date.now() }),
    lastPlayed: (track) => song(track).lastPlayed || 0,
    position: (track) => song(track).position || 0,
    setPosition: (track, seconds) => update(track, { position: seconds }),
    remembersPosition: (track) => orDefault(song(track).remember, isLongListen(track)),
    setRemembersPosition: (track, on) => update(track, { remember: on, position: on ? song(track).position : 0 }),
    skipsShuffle: (track) => orDefault(song(track).skip, isLongListen(track)),
    setSkipsShuffle: (track, on) => update(track, { skip: on }),
    get playlists() { return data.playlists; },
    findPlaylist,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    addToPlaylist,
    removeFromPlaylist,
    setPlaylistOrder,
  };
})();
