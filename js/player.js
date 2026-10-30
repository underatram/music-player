// One <audio> element plus the list of tracks it is working through.
const Player = (() => {
  const RESTART_THRESHOLD_SECONDS = 3;
  const audio = new Audio();
  const listeners = {};

  let source = []; // the list as it was chosen
  let queue = []; // the order it plays in, which differs when shuffling
  let upNext = []; // songs added with Play Next, which come before the rest of the list
  let fromUpNext = null; // the song playing, when it came from upNext
  let shuffleOn = false;
  let keepOrder = false; // this list plays in order even with shuffle on
  let repeatMode = 'off'; // 'off', 'one' or 'all'
  let failures = 0; // unplayable files in a row
  let skipsShuffle = null; // decides which songs shuffle leaves out
  let startPositionFor = null; // decides where a song starts
  let pendingStart = 0;
  let position = -1; // where the list has got to
  let objectUrl = null;

  const emit = (event, detail) => (listeners[event] || []).forEach((fn) => fn(detail));
  const current = () => fromUpNext || queue[position] || null;

  function on(event, fn) {
    (listeners[event] = listeners[event] || []).push(fn);
  }

  function playCurrent() {
    const track = current();
    pendingStart = startPositionFor ? startPositionFor(track) : 0;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = track.file.mediaUrl ? null : URL.createObjectURL(track.file);
    audio.src = track.file.mediaUrl || objectUrl;
    resume();
    emit('trackchange', track);
    emit('queuechange');
  }

  function load(index) {
    fromUpNext = null;
    position = index;
    playCurrent();
  }

  function playFromUpNext(index) {
    [fromUpNext] = upNext.splice(index, 1);
    playCurrent();
  }

  function resume() {
    // A failed load is reported by the audio element's error event instead.
    audio.play().catch(() => {});
  }

  function shuffled(tracks) {
    const result = [...tracks];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  // If shuffle would leave out everything, it plays everything.
  function shufflePool(tracks) {
    const pool = skipsShuffle ? tracks.filter((t) => !skipsShuffle(t)) : tracks;
    return pool.length ? pool : tracks;
  }

  // Leaving out index starts at the top, or anywhere at all when shuffling.
  // A song chosen by hand always plays, even one shuffle would leave out.
  // Songs waiting in Up Next play first, then the list from the chosen song.
  // inOrder ignores shuffle, for episodes and books.
  function playList(tracks, index = null, { inOrder = false } = {}) {
    source = tracks;
    failures = 0;
    keepOrder = inOrder;
    let start = index ?? 0;
    if (shuffleOn && !inOrder) {
      const pool = shufflePool(tracks);
      const first = index === null ? pool[Math.floor(Math.random() * pool.length)] : tracks[index];
      queue = [first, ...shuffled(pool.filter((t) => t !== first))];
      start = 0;
    } else {
      queue = tracks;
    }
    if (upNext.length) {
      position = start - 1;
      playFromUpNext(0);
    } else {
      load(start);
    }
  }

  // The current song keeps playing; only what comes after it changes.
  function setShuffle(on) {
    shuffleOn = on;
    keepOrder = false;
    const reached = queue[position];
    if (!reached) {
      // Up Next is playing ahead of a list that hasn't started yet.
      if (queue.length) {
        queue = on ? shuffled(shufflePool(source)) : source;
        position = -1;
        emit('queuechange');
      }
      return;
    }
    if (on) {
      queue = [reached, ...shuffled(shufflePool(source).filter((t) => t !== reached))];
      position = 0;
    } else {
      queue = source;
      position = source.indexOf(reached);
    }
    emit('queuechange');
  }

  function stop() {
    audio.pause();
    audio.currentTime = 0;
    emit('ended');
  }

  function advance() {
    if (upNext.length) {
      playFromUpNext(0);
    } else if (position + 1 < queue.length) {
      load(position + 1);
    } else if (repeatMode === 'all' && queue.length) {
      if (shuffleOn && !keepOrder) queue = shuffled(shufflePool(source));
      load(0);
    } else {
      stop();
    }
  }

  function next() {
    failures = 0;
    advance();
  }

  // Goes straight after the current song, ahead of anything added before it.
  // With nothing playing, the first of them starts.
  function playNext(tracks) {
    upNext.unshift(...tracks);
    if (!current()) {
      failures = 0;
      playFromUpNext(0);
    } else {
      emit('queuechange');
    }
  }

  function setRepeat(mode) {
    repeatMode = mode;
  }

  function onEnded() {
    emit('finished', current());
    if (repeatMode === 'one') {
      audio.currentTime = 0;
      resume();
    } else {
      advance();
    }
  }

  function previous() {
    failures = 0;
    const restart = audio.currentTime > RESTART_THRESHOLD_SECONDS;
    if (fromUpNext && !restart && position >= 0) load(position);
    else if (fromUpNext || restart || position <= 0) audio.currentTime = 0;
    else load(position - 1);
  }

  function toggle() {
    if (!current()) return;
    if (audio.paused) resume();
    else audio.pause();
  }

  function seek(seconds) {
    if (Number.isFinite(audio.duration)) audio.currentTime = seconds;
  }

  function setVolume(value) {
    audio.volume = value;
  }

  audio.addEventListener('play', () => emit('statechange'));
  audio.addEventListener('pause', () => emit('statechange'));
  audio.addEventListener('timeupdate', () => emit('time'));
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('playing', () => { failures = 0; });
  audio.addEventListener('loadedmetadata', () => {
    if (pendingStart > 0 && pendingStart < audio.duration) audio.currentTime = pendingStart;
    pendingStart = 0;
    emit('duration', { track: current(), seconds: audio.duration });
    emit('time');
  });
  audio.addEventListener('error', () => {
    if (!current()) return;
    emit('unplayable', current());
    // Stop if nothing left can play, so repeat can't loop forever.
    failures++;
    if (failures >= queue.length + upNext.length) stop();
    else advance();
  });

  return {
    audio,
    on,
    playList,
    playNext,
    setShuffle,
    setRepeat,
    setHooks: (hooks) => {
      skipsShuffle = hooks.skipsShuffle;
      startPositionFor = hooks.startPositionFor;
    },
    next,
    previous,
    toggle,
    seek,
    setVolume,
    get upNext() { return upNext; },
    get laterInList() { return queue.slice(position + 1); },
    jumpToUpNext: (index) => {
      failures = 0;
      playFromUpNext(index);
    },
    jumpInList: (index) => {
      failures = 0;
      load(position + 1 + index);
    },
    removeFromUpNext: (index) => {
      upNext.splice(index, 1);
      emit('queuechange');
    },
    clearUpNext: () => {
      upNext = [];
      emit('queuechange');
    },
    get track() { return current(); },
    get isPlaying() { return !audio.paused; },
  };
})();
