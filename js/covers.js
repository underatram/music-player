// Album covers, read from the music files only when something needs to show one.
const Covers = (() => {
  const CONCURRENT_READS = 4;

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

  function forTrack(track) {
    if (!covers.has(track.albumKey)) {
      covers.set(track.albumKey, new Promise((resolve) => {
        waiting.push({ track, resolve });
        pump();
      }));
    }
    return covers.get(track.albumKey);
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
    covers.clear();
  }

  return { forTrack, element, forgetAll };
})();
