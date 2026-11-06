// Decides what a sync does to an iPod. Kept apart from the page because a mistake
// here deletes songs, so it needs to be testable on its own.
const IpodPlan = (() => {
  const matchKey = (fold, album, title) => `${fold(album || '')}\0${fold(title || '')}`;

  // The library decides what stays on the iPod. Without one, a sync would empty it.
  function canSync({ driveMissing, refreshing, scanning, songCount }) {
    return !driveMissing && !refreshing && !scanning && songCount > 0;
  }

  // iPods need a disc and both totals to keep an album's songs in track order, so
  // anything the tags leave out is worked out from the album itself.
  function numbersFor(tracks) {
    const albumSizes = new Map();
    for (const track of tracks) albumSizes.set(track.albumKey, (albumSizes.get(track.albumKey) || 0) + 1);
    return new Map(tracks.map((track) => {
      const discNo = track.discNo || 1;
      return [track, {
        trackNo: track.trackNo || 0,
        trackTotal: track.trackTotal || Math.max(albumSizes.get(track.albumKey), track.trackNo || 0),
        discNo,
        discTotal: Math.max(track.discTotal || 1, discNo),
      }];
    }));
  }

  // The app lets two playlists share a name but an iPod can't tell them apart, so
  // the second becomes "Name 2".
  function uniqueNames(playlists) {
    const used = new Set();
    return playlists.map((list) => {
      let name = list.name;
      for (let n = 2; used.has(name); n++) name = `${list.name} ${n}`;
      used.add(name);
      return { ...list, name };
    });
  }

  // Which playlists to remember as this app's. Before a sync (done left out) that's
  // everything old and new, so a sync that gets stopped can't lose track of a
  // playlist it was due to delete. Only a sync that finished them all can forget any.
  function playlistsToRemember(managed, lists, done) {
    if (done === lists.writes.length + lists.deletes.length) return [...lists.kept];
    return [...new Set([...managed, ...lists.kept])];
  }

  // What to write to the iPod's playlists. Only playlists this app put there are ever
  // changed or deleted, so smart playlists and ones from elsewhere are left alone.
  // Songs are referred to by their path, or { add } for one this sync is adding.
  function planPlaylists({ playlists, ipodLists, managed, wantedKeys, songsThere, additions, key }) {
    const addedAt = new Map(additions.map((track, index) => [key(track), index]));
    const byName = new Map(ipodLists.map((list) => [list.name, list]));
    const named = uniqueNames(playlists);
    const names = new Set(named.map((list) => list.name));
    const writes = [];
    const conflicts = [];
    const kept = [];

    for (const { name, tracks } of named) {
      const existing = byName.get(name);
      if (existing && (existing.smart || existing.master || !managed.includes(name))) {
        conflicts.push(name);
        continue;
      }
      kept.push(name);
      const songs = tracks.filter((track) => wantedKeys.has(key(track))).map((track) => {
        if (addedAt.has(key(track))) return { add: addedAt.get(key(track)) };
        return { path: songsThere.get(key(track)).path };
      });
      const paths = songs.map((song) => song.path);
      const same = existing && !songs.some((song) => song.add !== undefined) && existing.paths.length === paths.length
        && existing.paths.every((path, i) => path === paths[i]);
      if (!same) writes.push({ name, songs });
    }

    const deletes = managed.filter((name) => !names.has(name) && byName.has(name) && !byName.get(name).smart && !byName.get(name).master);
    return { writes, deletes, conflicts, kept };
  }

  // wanted: the library songs that should be on the iPod. ipodSongs: what's on it.
  // Afterwards the iPod holds exactly what's wanted.
  function compute({ wanted, ipodSongs, fold, playlists = [], ipodLists = [], managed = [] }) {
    const key = (t) => matchKey(fold, t.album, t.title);
    const wantedKeys = new Set(wanted.map(key));
    const songsThere = new Map(ipodSongs.map((t) => [key(t), t]));
    const numbers = numbersFor(wanted);

    const additions = wanted.filter((t) => !songsThere.has(key(t)));
    const removals = ipodSongs.filter((t) => !wantedKeys.has(key(t)));
    const updates = wanted.flatMap((track) => {
      const there = songsThere.get(key(track));
      if (!there) return [];
      const want = numbers.get(track);
      const same = want.trackNo === there.trackNo && want.trackTotal === there.trackTotal
        && want.discNo === there.discNo && want.discTotal === there.discTotal;
      return same ? [] : [{ path: there.path, ...want }];
    });
    const lists = planPlaylists({ playlists, ipodLists, managed, wantedKeys, songsThere, additions, key });
    return { additions, removals, updates, numbers, lists };
  }

  return { canSync, compute, numbersFor, playlistsToRemember };
})();
