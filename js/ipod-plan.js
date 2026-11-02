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

  // wanted: the library songs that should be on the iPod. ipodSongs: what's on it.
  // Afterwards the iPod holds exactly what's wanted.
  function compute({ wanted, ipodSongs, fold }) {
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
    return { additions, removals, updates, numbers };
  }

  return { canSync, compute, numbersFor };
})();
