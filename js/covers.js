// Album covers, read from the music files only when something needs to show one.
const Covers = (() => {
  const CONCURRENT_READS = 4;
  const MAX_KEPT_COVERS = 200;

  const covers = new Map(); // album key -> Promise<object URL or null>
  const waiting = [];
  let reading = 0;

  function pump() {
    while (reading < CONCURRENT_READS && waiting.length) {
      const { track, resolve } = waiting.pop();
      reading++;
      Tags.read(track.file, { cover: true })
        .then((tags) => resolve(tags.cover ? URL.createObjectURL(tags.cover) : null))
        .catch(() => resolve(null))
        .finally(() => {
          reading--;
          pump();
        });
    }
  }

  function release(promise) {
    promise.then((url) => {
      if (url) URL.revokeObjectURL(url);
    });
  }

  // Keeps the most recently used covers. Pictures already on screen aren't
  // affected when their address is released; they've been loaded.
  function forTrack(track) {
    const known = covers.get(track.albumKey);
    if (known) {
      covers.delete(track.albumKey);
      covers.set(track.albumKey, known);
      return known;
    }
    const cover = new Promise((resolve) => {
      waiting.push({ track, resolve });
      pump();
    });
    covers.set(track.albumKey, cover);
    if (covers.size > MAX_KEPT_COVERS) {
      const [oldestKey, oldest] = covers.entries().next().value;
      covers.delete(oldestKey);
      release(oldest);
    }
    return cover;
  }

  // An element that shows the cover once it has loaded, and stays hidden if there isn't one.
  function element(track, className) {
    const image = document.createElement('img');
    image.className = className;
    image.alt = '';
    image.hidden = true;
    forTrack(track).then((url) => {
      if (!url) return;
      image.src = url;
      image.hidden = false;
    });
    return image;
  }

  // Covers that failed while a drive was unplugged get another chance when it's back.
  function forgetAll() {
    covers.forEach(release);
    covers.clear();
  }

  return { forTrack, element, forgetAll };
})();
