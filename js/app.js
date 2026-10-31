// Rendering and event wiring.
const App = (() => {
  const ROW_OVERSCAN = 8;
  const TOAST_MS = 4000;
  const MIN_RENDER_GAP_MS = 200;
  const SUPPORTS_PICKER = 'showDirectoryPicker' in window;

  // Each section drills down through these levels, ending at an album's tracks.
  const SECTIONS = [
    { label: 'Artists', icon: 'artist', steps: ['artist', 'album'], opensForSearch: true },
    { label: 'Albums', icon: 'album', steps: ['album'], opensForSearch: true },
    { label: 'Genres', icon: 'genre', steps: ['genre', 'artist', 'album'], opensForSearch: false },
    { label: 'Years', icon: 'year', steps: ['year', 'album'], opensForSearch: false },
  ];
  const SMART_LIST_SIZE = 100;
  const POSITION_SAVE_MS = 5000;
  const CONTINUE_CARDS = 2;
  const DRIVE_CHECK_MS = 3000;
  const IPOD_SPARE_BYTES = 500 * 1000 * 1000; // left free so the iPod keeps working well
  const UNTICKED_KEY = 'ipodUnticked';
  const MAX_EDIT_SONGS = 2000;
  const EDIT_READS_AT_ONCE = 16;
  const EDIT_SAVE_EVERY = 25;
  // The boxes in the edit window. Spans are out of six columns.
  const ALBUM_FIELDS = [
    { key: 'album', label: 'Album', span: 6 },
    { key: 'albumArtist', label: 'Album Artist', span: 3 },
    { key: 'genre', label: 'Genre', span: 3 },
    { key: 'year', label: 'Year', span: 2, numeric: true },
    { key: 'disc', label: 'Disc', span: 2, numeric: true },
    { key: 'discTotal', label: 'Of', span: 2, numeric: true },
  ];
  const SONG_FIELDS = [
    { key: 'title', label: 'Title', span: 6 },
    { key: 'artist', label: 'Artist', span: 3 },
    { key: 'albumArtist', label: 'Album Artist', span: 3 },
    { key: 'album', label: 'Album', span: 6 },
    { key: 'genre', label: 'Genre', span: 3 },
    { key: 'year', label: 'Year', span: 3, numeric: true },
    { key: 'track', label: 'Track', span: 1, numeric: true },
    { key: 'trackTotal', label: 'Of', span: 1, numeric: true },
    { key: 'disc', label: 'Disc', span: 1, numeric: true },
    { key: 'discTotal', label: 'Of', span: 1, numeric: true },
    { key: 'composer', label: 'Composer', span: 2 },
    { key: 'comment', label: 'Comment', span: 6 },
  ];
  const ROW_FIELDS = [
    { key: 'track', label: 'Track', numeric: true },
    { key: 'title', label: 'Title' },
    { key: 'artist', label: 'Artist' },
  ];
  const NEW_MUSIC_LIST = 'new-music';
  const NEAR_END_SECONDS = 5;
  const SMART_PLAYLISTS = [
    {
      value: 'recently-played',
      label: 'Recently Played',
      icon: 'clock',
      empty: 'Songs appear here once you\'ve played them.',
      tracks: () => tracksIn('music')
        .filter((t) => UserData.lastPlayed(t) > 0)
        .sort((a, b) => UserData.lastPlayed(b) - UserData.lastPlayed(a))
        .slice(0, SMART_LIST_SIZE),
    },
    {
      value: 'most-played',
      label: 'Most Played',
      icon: 'chart',
      empty: 'Songs appear here once you\'ve played them.',
      tracks: () => tracksIn('music')
        .filter((t) => UserData.plays(t) > 0)
        .sort((a, b) => UserData.plays(b) - UserData.plays(a))
        .slice(0, SMART_LIST_SIZE),
    },
    {
      value: 'most-liked',
      label: 'Most Liked',
      icon: 'heart',
      empty: 'Click the heart on a song to add it here.',
      tracks: () => tracksIn('music')
        .filter((t) => UserData.isFavourite(t))
        .sort((a, b) => UserData.plays(b) - UserData.plays(a)),
    },
  ];

  // The library splits into these by genre. Podcasts and audiobooks keep their
  // place, so they get lists of what's under way instead of smart playlists.
  const SHELVES = [
    { id: 'music', label: 'Music', search: 'Search music', smart: SMART_PLAYLISTS },
    {
      id: 'podcasts',
      label: 'Podcasts',
      genre: 'podcast',
      search: 'Search podcasts',
      none: 'No podcasts yet. Songs with the genre Podcast appear here.',
      smart: [
        {
          value: 'podcasts-in-progress',
          label: 'In Progress',
          empty: 'Episodes you\'ve started appear here.',
          tracks: () => tracksIn('podcasts').filter((t) => UserData.position(t) > 0),
        },
        {
          value: 'podcasts-recently-played',
          label: 'Recently Played',
          empty: 'Episodes appear here once you\'ve played them.',
          tracks: () => tracksIn('podcasts')
            .filter((t) => UserData.lastPlayed(t) > 0)
            .sort((a, b) => UserData.lastPlayed(b) - UserData.lastPlayed(a))
            .slice(0, SMART_LIST_SIZE),
        },
      ],
    },
    {
      id: 'audiobooks',
      label: 'Audiobooks',
      genre: 'audiobook',
      search: 'Search audiobooks',
      none: 'No audiobooks yet. Songs with the genre Audiobook appear here.',
      smart: [
        {
          value: 'audiobooks-in-progress',
          label: 'In Progress',
          empty: 'Books you\'ve started appear here.',
          tracks: () => booksWhere((book) => book.left > 0 && book.left < book.total),
        },
        {
          value: 'audiobooks-finished',
          label: 'Finished',
          empty: 'Books you\'ve finished appear here.',
          tracks: () => booksWhere((book) => book.left === 0),
        },
      ],
    },
  ];
  const ALL_SMART_LISTS = SHELVES.flatMap((s) => s.smart);
  const ALL_LABELS = { artist: 'All Artists', album: 'All Albums', genre: 'All Genres', year: 'All Years' };
  const REPEAT_NEXT = { off: 'one', one: 'all', all: 'off' };
  const REPEAT_LABELS = { off: 'Repeat is off', one: 'Repeating this song', all: 'Repeating this list' };

  // How each column sorts. Empty values go last whichever way the column runs.
  const COLUMNS = [
    { label: 'Title', className: 'column-title', value: (t) => t.title },
    { label: 'Artist', value: (t) => t.artistSort },
    { label: 'Album', value: (t) => t.album },
    { label: 'Year', value: (t) => t.year },
    { label: 'Genre', value: (t) => t.genre },
    { label: 'Time', className: 'column-time', value: (t) => t.duration },
    { label: 'Play Count', value: (t) => UserData.plays(t) || null },
  ];
  // Takes the Genre column's place in Recently Played.
  const LAST_PLAYED_COLUMN = { label: 'Last Played', value: (t) => UserData.lastPlayed(t) || null };

  const $ = (selector) => document.querySelector(selector);
  const content = $('#content');
  const scroller = $('#scroller');
  const nav = $('#nav');
  const searchInput = $('#search');
  const seekBar = $('#seek');
  const volumeBar = $('#volume');
  const phoneLayout = window.matchMedia('(max-width: 820px)');

  let shelf = SHELVES[0]; // Music, Podcasts or Audiobooks
  const shelfPlaces = new Map(); // where each one was left: { path, openSection }
  let shelfCache = { source: null, lists: {} };
  let heroBook = null; // the book at the top of the Audiobooks page
  let openSection = null; // the tab open while browsing
  const flipped = new Set(); // tabs opened or closed by hand during a search
  const filterScroll = new Map(); // each tab's scroll position
  let matched = []; // the songs the search allows, or all of them
  let path = []; // what's chosen in the sidebar: [{ field, value, label }, ...]
  let revealSelection = false;
  let visibleTracks = [];
  let sortColumn = null;
  let sortDescending = false;
  let query = '';
  let scanning = false;
  let savedFolder = null;
  let driveMissing = false; // the chosen folder has gone, usually an unplugged drive
  let refreshing = false; // a check of the folder is running
  let scanReport = null; // what the last scan found, until it's dismissed
  let newMusicPaths = new Set(); // the songs the last scan added
  let ipod = null; // the connected iPod, if there is one
  let ipodOpen = false; // its page is showing instead of the library
  let ipodStamp = ''; // changes when there's something new to show
  let ipodSongs = []; // every song on the iPod
  let ipodSync = null; // how a running sync is going
  let ipodResult = null; // what the last sync did
  let songList = null; // the virtual list of songs on screen
  let filterLists = []; // the virtual lists in the sidebar
  let toastTimer = null;
  let lastRender = 0;
  let lastRenderCost = 0;

  // ---- Helpers ----

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value);
    }
    node.append(...children.filter((c) => c !== null && c !== undefined));
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '';
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    const secs = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
  }

  function formatTotal(seconds) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
  }

  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, TOAST_MS);
  }

  function setSliderFill(slider) {
    const range = Number(slider.max) - Number(slider.min);
    const percent = range ? ((slider.value - slider.min) / range) * 100 : 0;
    slider.style.setProperty('--fill', `${percent}%`);
  }

  function cssPixels(name) {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  }

  // Only the rows near the visible area exist in the page, so very large
  // libraries stay fast.
  function virtualList(scrollBox, node, count, rowHeight, renderRow) {
    let first = -1;
    let last = -1;
    node.style.height = `${count * rowHeight}px`;

    function draw(force = false) {
      if (!node.isConnected) return;
      const offset = scrollBox.getBoundingClientRect().top - node.getBoundingClientRect().top;
      const nextFirst = Math.max(0, Math.floor(offset / rowHeight) - ROW_OVERSCAN);
      const nextLast = Math.min(count, Math.ceil((offset + scrollBox.clientHeight) / rowHeight) + ROW_OVERSCAN);
      if (!force && nextFirst === first && nextLast === last) return;
      first = nextFirst;
      last = nextLast;

      const rows = [];
      for (let i = first; i < last; i++) {
        const row = renderRow(i);
        row.style.top = `${i * rowHeight}px`;
        rows.push(row);
      }
      node.replaceChildren(...rows);
    }
    return { draw };
  }

  // ---- Music, Podcasts and Audiobooks ----

  function shelfFor(track) {
    return SHELVES.find((s) => s.genre === track.genreKey) || SHELVES[0];
  }

  function tracksIn(id) {
    const all = Library.tracks;
    if (shelfCache.source !== all) shelfCache = { source: all, lists: {} };
    if (!shelfCache.lists[id]) shelfCache.lists[id] = all.filter((t) => shelfFor(t).id === id);
    return shelfCache.lists[id];
  }

  // How long is left of an episode: a saved place, or all of it until it's been played.
  function secondsLeft(track) {
    const position = UserData.position(track);
    if (position > 0) return Math.max(0, (track.duration || 0) - position);
    return UserData.plays(track) ? 0 : (track.duration || 0);
  }

  function episodeProgress(track) {
    if (UserData.position(track) > 0) return `${formatTotal(secondsLeft(track))} left`;
    return UserData.plays(track) ? 'Played' : '';
  }

  // A book is an album, usually of one long file.
  function bookFrom(group) {
    const { tracks } = group;
    return {
      ...group,
      total: tracks.reduce((sum, t) => sum + (t.duration || 0), 0),
      left: tracks.reduce((sum, t) => sum + secondsLeft(t), 0),
    };
  }

  const booksIn = (tracks) => Library.groups('album', tracks).map(bookFrom);
  const booksWhere = (test) => booksIn(tracksIn('audiobooks')).filter(test).flatMap((book) => book.tracks);

  function bookProgress(book) {
    if (book.left === 0) return 'Finished';
    return book.left < book.total ? `${formatTotal(book.left)} left` : '';
  }

  // Which file to pick a book up from.
  function bookStart(book) {
    const started = book.tracks.findIndex((t) => UserData.position(t) > 0);
    if (started >= 0) return started;
    return Math.max(0, book.tracks.findIndex((t) => !UserData.plays(t)));
  }

  function shelfCount(s) {
    if (s.id === 'music') return plural(tracksIn('music').length, 'song');
    return plural(Library.groups('album', tracksIn(s.id)).length, s.id === 'podcasts' ? 'show' : 'book');
  }

  function openManageMenu() {
    const button = $('#manage-library');
    const { left, top } = button.getBoundingClientRect();
    const { width } = $('.side-foot').getBoundingClientRect();
    showMenu({ clientX: left, clientY: top - 4 }, [
      ...(Host ? [{ label: 'Scan Folder for Changes', action: scanFolder }, 'line'] : []),
      { label: 'Change Folder…', action: pickFolder },
    ], { width, above: true });
    button.setAttribute('aria-expanded', 'true');
  }

  function renderShelfSwitch() {
    $('#shelf-label').textContent = shelf.label;
    searchInput.placeholder = shelf.search;
    searchInput.setAttribute('aria-label', shelf.search);
  }

  function openShelfMenu() {
    const button = $('#shelf-button');
    const { left, bottom, width } = button.getBoundingClientRect();
    showMenu({ clientX: left, clientY: bottom + 4 }, SHELVES.map((s) => ({
      label: s.label,
      detail: shelfCount(s),
      checked: s === shelf,
      radio: true,
      action: () => {
        if (s !== shelf) setShelf(s);
      },
    })), { width });
    button.setAttribute('aria-expanded', 'true');
  }

  // Each one keeps its own place. A search belongs to the tab it was typed in.
  function setShelf(next) {
    ipodOpen = false;
    shelfPlaces.set(shelf.id, { path, openSection });
    shelf = next;
    const place = shelfPlaces.get(shelf.id) || { path: [], openSection: null };
    path = place.path;
    openSection = place.openSection;
    if (path.length && path[0].field !== 'playlist' && !Library.within(path, tracksIn(shelf.id)).length) path = [];
    searchInput.value = '';
    query = '';
    sortColumn = null;
    flipped.clear();
    filterScroll.clear();
    clearSelection();
    scroller.scrollTop = 0;
    try {
      localStorage.setItem('shelf', shelf.id);
    } catch {
      // Storage can be blocked; it just opens on Music next time.
    }
    render();
  }

  function restoreShelf() {
    let saved = null;
    try {
      saved = localStorage.getItem('shelf');
    } catch {
      // Storage can be blocked; it opens on Music.
    }
    shelf = SHELVES.find((s) => s.id === saved) || SHELVES[0];
  }

  // Starts a list. Anything already in Up Next plays first, and says so.
  function startList(tracks, index = null, { name = null, ...options } = {}) {
    const waiting = Player.upNext.length;
    Player.playList(tracks, index, options);
    if (!waiting) return;
    const listName = name || (path.length ? path[path.length - 1].label : 'this list');
    showToast(`${plural(waiting, 'queued song')} will play first, then ${listName}.`);
  }

  // ---- Which songs are showing ----

  function playlistTracks(id) {
    if (id === NEW_MUSIC_LIST) return tracksIn(shelf.id).filter((t) => newMusicPaths.has(t.path));
    const smart = ALL_SMART_LISTS.find((p) => p.value === id);
    if (smart) return smart.tracks();
    const playlist = UserData.findPlaylist(id);
    return playlist ? playlist.songs.map(Library.byKey).filter(Boolean) : [];
  }

  const inPlaylist = () => path.length > 0 && path[0].field === 'playlist';

  function baseTracks() {
    if (inPlaylist()) {
      const tracks = playlistTracks(path[0].value);
      if (!query) return tracks;
      const allowed = new Set(matched);
      return tracks.filter((t) => allowed.has(t));
    }
    return Library.within(path, matched);
  }

  const isRecentlyPlayed = () => inPlaylist() && path[0].value === 'recently-played';

  // A search only keeps playlists holding a match.
  function matchingPlaylists(entries) {
    if (!query) return entries;
    const allowed = new Set(matched);
    return entries.filter((entry) => playlistTracks(entry.value).some((t) => allowed.has(t)));
  }

  function formatAgo(timestamp) {
    if (!timestamp) return '';
    const minutes = Math.floor((Date.now() - timestamp) / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} hr ago`;
    const days = Math.floor(minutes / (24 * 60));
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function sortTracks(tracks) {
    if (!sortColumn) return tracks;
    const direction = sortDescending ? -1 : 1;
    const { value } = sortColumn;
    // Array.prototype.sort is stable, so ties keep artist, album, track order.
    return [...tracks].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      const aEmpty = av === null || av === undefined;
      const bEmpty = bv === null || bv === undefined;
      if (aEmpty || bEmpty) return aEmpty - bEmpty;
      const result = typeof av === 'number' ? av - bv : Library.compareText(av, bv);
      return direction * result;
    });
  }

  function selectPath(next) {
    path = next;
    ipodOpen = false;
    scanReport = null;
    clearSelection();
    scroller.scrollTop = 0;
    render();
  }

  // A new search starts over: its tabs and results come from the new term.
  function setQuery(text) {
    if (text === query) return;
    query = text;
    flipped.clear();
    filterScroll.clear();
    selectPath([]);
  }

  function sortBy(column) {
    sortDescending = sortColumn === column ? !sortDescending : false;
    sortColumn = column;
    scroller.scrollTop = 0;
    renderMain();
  }

  // ---- Sidebar ----

  // A tab lists its section's first level; the main area drills from there.
  function renderFilters(tab, groups) {
    const field = tab.steps[0];
    const entries = [{ label: ALL_LABELS[field], isAll: true }, ...groups];
    const rowHeight = cssPixels('--filter-height');
    const isSelected = (entry) => (entry.isAll
      ? path.length === 0 || path[0].field !== field
      : path.length > 0 && path[0].field === field && path[0].value === entry.value);

    const rows = el('div', { class: 'filter-rows' });
    const box = el('div', { class: 'filters', 'data-section': tab.label }, rows);

    const list = virtualList(box, rows, entries.length, rowHeight, (i) => {
      const entry = entries[i];
      return el('button', {
        class: 'filter',
        title: entry.label,
        'aria-current': isSelected(entry) ? 'true' : 'false',
        onclick: () => selectPath(entry.isAll ? [] : [{ field, value: entry.value, label: entry.label }]),
        oncontextmenu: (event) => {
          event.preventDefault();
          if (!entry.isAll) showGroupMenu(event, entry.tracks);
        },
      }, el('span', { class: 'filter-title' }, entry.label));
    });
    box.addEventListener('scroll', () => list.draw());

    const selectedIndex = entries.findIndex(isSelected);
    return { box, list, reveal: () => { box.scrollTop = selectedIndex * rowHeight; } };
  }

  function isTabOpen(tab, matchCount) {
    if (query) return matchCount > 0 && tab.opensForSearch !== flipped.has(tab.label);
    return openSection === tab;
  }

  function toggleTab(tab, matchCount) {
    if (query) {
      if (!matchCount) return;
      if (flipped.has(tab.label)) flipped.delete(tab.label);
      else flipped.add(tab.label);
    } else {
      openSection = openSection === tab ? null : tab;
    }
    renderSide();
    nav.querySelector(`[data-tab="${tab.label}"]`).focus();
  }

  function renderSide() {
    nav.querySelectorAll('.filters').forEach((box) => filterScroll.set(box.dataset.section, box.scrollTop));
    const hasMusic = Library.tracks.length > 0;

    const children = [];
    const opened = [];
    for (const tab of shelf.id === 'music' ? SECTIONS : []) {
      const groups = hasMusic
        ? Library.groups(tab.steps[0], matched, { byName: tab.label === 'Albums' })
        : [];
      const open = hasMusic && isTabOpen(tab, groups.length);
      children.push(el('button', {
        class: `section ${open && !query ? 'section-active' : ''} ${query && !groups.length ? 'section-empty' : ''}`,
        'data-tab': tab.label,
        'aria-expanded': open ? 'true' : 'false',
        onclick: () => toggleTab(tab, groups.length),
      },
        icon(tab.icon),
        el('span', { class: 'section-label' }, tab.label),
        query ? el('span', { class: 'section-count' }, groups.length.toLocaleString()) : null));
      if (open) {
        const filters = renderFilters(tab, groups);
        children.push(filters.box);
        opened.push({ tab, filters });
      }
    }
    nav.replaceChildren(...children);

    filterLists = opened.map(({ filters }) => filters.list);
    for (const { tab, filters } of opened) {
      if (revealSelection) filters.reveal();
      else filters.box.scrollTop = filterScroll.get(tab.label) || 0;
      filters.list.draw(true);
    }
    revealSelection = false;
    $('#play').disabled = !Player.track && !hasMusic;
    renderPlaylists(hasMusic);
  }

  // Playlists aren't a way of browsing the library, so they sit in their own
  // always-open section: the smart ones first, then the person's own.
  function renderPlaylists(hasMusic) {
    const box = $('#playlists');
    box.hidden = !hasMusic;
    box.classList.toggle('playlists-full', shelf.id !== 'music');
    if (!hasMusic) return;
    const top = box.scrollTop;

    const row = (entry) => el('button', {
      class: 'playlist',
      title: entry.label,
      'aria-current': (entry.isCurrent ? entry.isCurrent() : inPlaylist() && path[0].value === entry.value) ? 'true' : 'false',
      onclick: () => {
        // Playlists open in their own order, not whichever column was last sorted.
        sortColumn = null;
        selectPath(entry.path || [{ field: 'playlist', value: entry.value, label: entry.label }]);
      },
      oncontextmenu: entry.editable
        ? (event) => {
          event.preventDefault();
          showPlaylistMenu(event, entry);
        }
        : (event) => event.preventDefault(),
    }, entry.icon ? icon(entry.icon) : null, el('span', { class: 'playlist-label' }, entry.label));

    if (shelf.id !== 'music') {
      box.replaceChildren(...renderListening(row));
      box.scrollTop = top;
      return;
    }

    const smart = matchingPlaylists(SMART_PLAYLISTS.map(({ value, label, icon: name }) => ({ value, label, icon: name })));
    const own = matchingPlaylists(UserData.playlists.map((p) => ({ value: p.id, label: p.name, icon: 'playlist', editable: true })));

    box.replaceChildren(...[
      smart.length ? el('h2', { class: 'playlists-heading' }, 'Smart Playlists') : null,
      ...smart.map(row),
      own.length || !query ? el('div', { class: 'playlists-heading-row' },
        el('h2', { class: 'playlists-heading' }, 'My Playlists'),
        query ? null : el('button', { class: 'playlist-new', onclick: () => createPlaylist() }, icon('plus'), 'New')) : null,
      ...own.map(row),
      !query && !own.length ? el('p', { class: 'playlists-empty' }, 'Your playlists appear here.') : null,
      query && !smart.length && !own.length ? el('p', { class: 'playlists-empty' }, 'No playlists match.') : null,
    ].filter(Boolean));
    box.scrollTop = top;
  }

  // The Podcasts and Audiobooks sidebars: everything, then what's under way.
  function renderListening(row) {
    const all = {
      label: shelf.id === 'podcasts' ? 'All Shows' : 'All Books',
      path: [],
      isCurrent: () => !path.length || path[0].field === 'album',
    };
    const listening = matchingPlaylists(shelf.smart.map(({ value, label }) => ({ value, label })));
    return [all, ...listening].map(row);
  }

  // ---- Song list ----

  function toggleFavourite(track, heart) {
    UserData.toggleFavourite(track);
    if (heart) heart.setAttribute('aria-pressed', UserData.isFavourite(track) ? 'true' : 'false');
    updateNowHeart();
    if (inPlaylist() && path[0].value === 'most-liked') renderMain();
  }

  function updateNowHeart() {
    const heart = $('#now-heart');
    heart.disabled = !Player.track;
    heart.setAttribute('aria-pressed', Player.track && UserData.isFavourite(Player.track) ? 'true' : 'false');
  }

  // Starting an album clears the sidebar's tabs out of the way.
  function closeTabsForAlbum() {
    if (query || !path.length || path[path.length - 1].field !== 'album' || !openSection) return;
    openSection = null;
    renderSide();
  }

  // ---- Selecting several songs ----
  // Ctrl-click, Shift-click and Ctrl-A select; a plain click still plays.

  const selection = new Set();
  let selectionAnchor = null;
  let showLastPlayed = false; // whether the song list on screen has that column

  function clearSelection() {
    selection.clear();
    selectionAnchor = null;
  }

  function refreshSelection() {
    if (songList) songList.draw(true);
    const count = content.querySelector('.selection-count');
    if (count) count.textContent = selection.size ? `${selection.size.toLocaleString()} selected` : '';
  }

  function clickSongRow(event, tracks, index) {
    if (event.ctrlKey || event.metaKey) {
      const track = tracks[index];
      if (selection.has(track)) selection.delete(track);
      else selection.add(track);
      selectionAnchor = index;
      refreshSelection();
    } else if (event.shiftKey) {
      const from = selectionAnchor ?? index;
      selection.clear();
      for (let i = Math.min(from, index); i <= Math.max(from, index); i++) selection.add(tracks[i]);
      selectionAnchor = from;
      refreshSelection();
    } else {
      clearSelection();
      refreshSelection();
      startList(tracks, index, { inOrder: shelf.id !== 'music' });
      closeTabsForAlbum();
    }
  }

  function selectAllShown() {
    if (!songList || nextField() || !visibleTracks.length) return;
    visibleTracks.forEach((track) => selection.add(track));
    refreshSelection();
  }

  // ---- Podcasts and Audiobooks pages ----

  const coverObserver = new IntersectionObserver((entries) => {
    for (const { isIntersecting, target } of entries) {
      if (!isIntersecting) continue;
      coverObserver.unobserve(target);
      target.append(Covers.element(target.coverTrack, 'cover cover-fill'));
    }
  }, { root: scroller, rootMargin: '300px' });

  // Holds a cover's place, and only reads it from the file once it's nearly on screen.
  function coverTile(track, className) {
    const tile = el('span', { class: `cover-tile ${className}` });
    tile.coverTrack = track;
    coverObserver.observe(tile);
    return tile;
  }

  function progressBar(percent) {
    if (!percent) return null;
    return el('span', { class: `progress-bar ${percent >= 100 ? 'progress-bar-done' : ''}` },
      el('span', { class: 'progress-bar-fill', style: `width: ${percent}%` }));
  }

  function episodePercent(track) {
    if (UserData.position(track) > 0 && track.duration) return (UserData.position(track) / track.duration) * 100;
    return UserData.plays(track) ? 100 : 0;
  }

  function episodeRow(track, tracks, index, withShow) {
    const progress = episodeProgress(track);
    const details = [withShow ? track.album : null, track.year, track.duration ? formatTotal(track.duration) : null];
    return el('button', {
      class: `row episode ${selection.has(track) ? 'row-selected' : ''} ${progress === 'Played' ? 'row-done' : ''}`,
      'data-track': track.id,
      'aria-current': Player.track && Player.track.id === track.id ? 'true' : null,
      onclick: (event) => clickSongRow(event, tracks, index),
      oncontextmenu: (event) => {
        event.preventDefault();
        showSongMenu(event, track);
      },
    },
      el('span', { class: 'episode-text' },
        el('span', { class: 'row-title' }, track.title),
        el('span', { class: 'episode-meta' }, details.filter(Boolean).join(' · '))),
      el('span', { class: 'episode-progress' },
        el('span', { class: 'episode-left', 'data-left': progress.endsWith('left') ? 'true' : null }, progress),
        progressBar(episodePercent(track))));
  }

  function episodeList(tracks, withShow) {
    const rows = el('div', { class: 'rows' });
    songList = virtualList(scroller, rows, tracks.length, cssPixels('--episode-height'), (i) => episodeRow(tracks[i], tracks, i, withShow));
    return el('div', { class: 'rows-wrap' }, rows);
  }

  const selectionCount = () => el('span', { class: 'selection-count' }, selection.size ? `${selection.size.toLocaleString()} selected` : '');

  // Search results, In Progress and Recently Played.
  function renderEpisodeLists() {
    const tracks = baseTracks();
    visibleTracks = tracks;
    const total = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    const details = [plural(tracks.length, query && !path.length ? 'result' : 'episode')];
    if (total) details.push(formatTotal(total));
    return [
      el('h1', { class: 'heading' }, path.length ? path[0].label : `Results for “${query}”`),
      el('p', { class: 'meta' }, details.join(' · ')),
      tracks.length ? el('div', { class: 'page-links' },
        el('button', { class: 'page-link', onclick: () => startList(visibleTracks, 0, { inOrder: true }) }, icon('play'), 'Play'),
        selectionCount()) : null,
      tracks.length ? episodeList(tracks, true) : el('p', { class: 'empty' }, emptyMessage()),
    ].filter(Boolean);
  }

  function renderShowPage() {
    const tracks = baseTracks();
    visibleTracks = tracks;
    const started = tracks.findIndex((t) => UserData.position(t) > 0);
    // The newest episode: the latest year, and the last of that year in the show's order.
    const newest = tracks.reduce((best, t, i) => ((t.year || 0) >= (tracks[best].year || 0) ? i : best), 0);
    const start = started >= 0 ? started : newest;
    const details = [tracks[0].groupArtist, plural(tracks.length, 'episode')];
    return [
      el('nav', { class: 'crumbs', 'aria-label': 'Back to' }, icon('back'),
        el('button', { class: 'crumb', onclick: () => selectPath([]) }, 'Podcasts')),
      el('div', { class: 'hero' },
        coverTile(tracks[0], 'cover-show'),
        el('div', { class: 'hero-text' },
          el('h1', { class: 'heading' }, path[0].label),
          el('p', { class: 'meta' }, details.join(' · ')),
          el('div', { class: 'hero-actions' },
            el('button', { class: 'hero-action', onclick: () => startList(tracks, start, { inOrder: true }) },
              icon('play'),
              el('span', { class: 'hero-action-label' }, started >= 0 ? `Carry On: ${tracks[started].title}` : 'Play Latest')),
            selectionCount()))),
      episodeList(tracks, false),
    ];
  }

  function continueCard(track) {
    return el('button', {
      class: 'continue-card',
      onclick: () => selectPath([{ field: 'album', value: track.albumKey, label: track.album }]),
      oncontextmenu: (event) => {
        event.preventDefault();
        showSongMenu(event, track);
      },
    },
      coverTile(track, 'cover-continue'),
      el('span', { class: 'continue-text' },
        el('span', { class: 'continue-show' }, track.album),
        el('span', { class: 'continue-title' }, track.title),
        progressBar(episodePercent(track)),
        el('span', { class: 'continue-left' }, episodeProgress(track))));
  }

  function showCard(group) {
    return el('button', {
      class: 'cover-card',
      title: group.label,
      onclick: () => selectPath([{ field: 'album', value: group.value, label: group.label }]),
      oncontextmenu: (event) => {
        event.preventDefault();
        showGroupMenu(event, group.tracks);
      },
    },
      coverTile(group.tracks[0], 'cover-square'),
      el('span', { class: 'cover-card-title' }, group.label),
      el('span', { class: 'cover-card-detail' }, plural(group.tracks.length, 'episode')));
  }

  function renderPodcasts() {
    if (path.length && path[0].field === 'album') return renderShowPage();
    if (query || path.length) return renderEpisodeLists();
    const shows = Library.groups('album', matched, { byName: true });
    const underWay = matched
      .filter((t) => UserData.position(t) > 0)
      .sort((a, b) => UserData.lastPlayed(b) - UserData.lastPlayed(a))
      .slice(0, CONTINUE_CARDS);
    return [
      el('h1', { class: 'heading page-title-only' }, 'Podcasts'),
      !shows.length ? el('p', { class: 'empty' }, shelf.none) : null,
      underWay.length ? el('h2', { class: 'shelf-heading' }, 'Continue Listening') : null,
      underWay.length ? el('div', { class: 'continue-grid' }, ...underWay.map(continueCard)) : null,
      shows.length ? el('h2', { class: 'shelf-heading' }, 'Shows') : null,
      shows.length ? el('div', { class: 'cover-grid' }, ...shows.map(showCard)) : null,
    ].filter(Boolean);
  }

  // "Mythos — a Retelling of the Myths" is a title and a subtitle.
  function bookNames(book) {
    const [title, ...rest] = book.label.split(' — ');
    return { title, subtitle: rest.join(' — ') };
  }

  function bookStatus(book) {
    if (book.left === 0) return 'Finished';
    return book.left < book.total ? `${formatTotal(book.left)} left` : 'Not started';
  }

  const bookPercent = (book) => (book.total ? ((book.total - book.left) / book.total) * 100 : 0);

  function chooseHeroBook(books) {
    const playing = Player.track && books.find((book) => book.value === Player.track.albumKey);
    return books.find((book) => book.value === heroBook)
      || playing
      || books.find((book) => book.left > 0 && book.left < book.total)
      || books.find((book) => book.left > 0)
      || books[0];
  }

  function renderBookHero(book) {
    const { title, subtitle } = bookNames(book);
    const { groupArtist, albumYear } = book.tracks[0];
    const details = [groupArtist, albumYear, book.total ? formatTotal(book.total) : null];
    const isStarted = book.left < book.total;
    let state = 'Up Next';
    if (isStarted) state = book.left ? 'Continue Listening' : 'Finished';
    let action = 'Start Listening';
    if (isStarted) action = book.left ? 'Carry On Listening' : 'Listen Again';
    return el('section', { class: 'book-hero' },
      coverTile(book.tracks[0], 'cover-book'),
      el('div', { class: 'hero-text' },
        el('div', { class: 'book-state' }, state),
        el('h1', { class: 'heading' }, title),
        subtitle ? el('p', { class: 'book-subtitle' }, subtitle) : null,
        el('p', { class: 'book-details' }, details.filter(Boolean).join(' · ')),
        progressBar(bookPercent(book)),
        isStarted && book.left ? el('div', { class: 'book-left' }, `${formatTotal(book.left)} left of ${formatTotal(book.total)}`) : null,
        el('div', { class: 'hero-actions' },
          el('button', { class: 'hero-action', onclick: () => startList(book.tracks, bookStart(book), { inOrder: true, name: title }) },
            icon('play'), el('span', { class: 'hero-action-label' }, action)))));
  }

  function bookCard(book, hero) {
    const status = bookStatus(book);
    return el('button', {
      class: 'cover-card',
      title: book.label,
      'aria-pressed': book === hero ? 'true' : 'false',
      onclick: () => {
        // A search or list has no book at the top, so go back to the page that does.
        heroBook = book.value;
        searchInput.value = '';
        query = '';
        flipped.clear();
        selectPath([]);
      },
      oncontextmenu: (event) => {
        event.preventDefault();
        showGroupMenu(event, book.tracks);
      },
    },
      coverTile(book.tracks[0], 'cover-square'),
      progressBar(bookPercent(book)) || el('span', { class: 'progress-bar-empty' }),
      el('span', { class: 'cover-card-title' }, bookNames(book).title),
      el('span', { class: 'cover-card-detail', 'data-left': status.endsWith('left') ? 'true' : null }, status));
  }

  function renderAudiobooks() {
    const tracks = baseTracks();
    visibleTracks = tracks;
    const books = booksIn(tracks);
    if (!query && !path.length) {
      if (!books.length) return [el('h1', { class: 'heading page-title-only' }, 'Audiobooks'), el('p', { class: 'empty' }, shelf.none)];
      const hero = chooseHeroBook(books);
      return [
        renderBookHero(hero),
        el('h2', { class: 'shelf-heading' }, 'All Audiobooks'),
        el('div', { class: 'cover-grid' }, ...books.map((book) => bookCard(book, hero))),
      ];
    }
    return [
      el('h1', { class: 'heading' }, path.length ? path[0].label : `Results for “${query}”`),
      el('p', { class: 'meta' }, plural(books.length, 'book')),
      books.length
        ? el('div', { class: 'cover-grid' }, ...books.map((book) => bookCard(book, null)))
        : el('p', { class: 'empty' }, emptyMessage()),
    ];
  }

  function songRow(track, tracks, index, reorder) {
    const isCurrent = Player.track && Player.track.id === track.id;
    const favourite = UserData.isFavourite(track);
    const heart = el('span', {
      class: 'row-heart',
      role: 'button',
      'aria-label': 'Favourite',
      'aria-pressed': favourite ? 'true' : 'false',
      onclick: (event) => {
        event.stopPropagation();
        toggleFavourite(track, heart);
      },
    }, icon('heart'));
    return el('button', {
      class: `row ${selection.has(track) ? 'row-selected' : ''}`,
      'data-track': track.id,
      'aria-current': isCurrent ? 'true' : null,
      draggable: reorder ? 'true' : null,
      ondragstart: reorder ? (event) => reorder.start(event, index) : null,
      onclick: (event) => clickSongRow(event, tracks, index),
      oncontextmenu: (event) => {
        event.preventDefault();
        showSongMenu(event, track);
      },
    },
      el('span', { class: 'row-title' }, track.title),
      el('span', { class: 'row-sub' }, `${track.artist} · ${track.album}`),
      el('span', { class: 'row-artist' }, track.artist),
      el('span', { class: 'row-album' }, track.album),
      el('span', { class: 'row-year' }, track.year ? String(track.year) : ''),
      el('span', { class: 'row-genre' }, isRecentlyPlayed() ? formatAgo(UserData.lastPlayed(track)) : (track.genre || '')),
      el('span', { class: 'row-time' }, formatTime(track.duration)),
      el('span', { class: 'row-plays' }, UserData.plays(track) ? String(UserData.plays(track)) : ''),
      showLastPlayed ? el('span', { class: 'row-last' }, formatAgo(UserData.lastPlayed(track))) : null,
      heart);
  }

  // Links back up through the levels above the current one.
  function renderCrumbs() {
    if (path.length < 2) return null;
    const links = [];
    path.slice(0, -1).forEach((step, i) => {
      links.push(el('button', { class: 'crumb', onclick: () => selectPath(path.slice(0, i + 1)) }, step.label));
    });
    return el('nav', { class: 'crumbs', 'aria-label': 'Back to' }, icon('back'), ...links);
  }

  // The level between the sidebar and the tracks: an artist's albums, say.
  function nextField() {
    if (!path.length || inPlaylist()) return null;
    const { steps } = SECTIONS.find((tab) => tab.steps[0] === path[0].field);
    return steps[path.length] || null;
  }

  function groupRow(entry, field, showArtist) {
    const { groupArtist, albumYear } = entry.tracks[0];
    const seconds = entry.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    const songs = plural(entry.tracks.length, 'song');
    const isAlbum = field === 'album';
    const summary = isAlbum
      ? [showArtist ? groupArtist : null, albumYear, songs].filter(Boolean).join(' · ')
      : `${plural(Library.groups('album', entry.tracks).length, 'album')} · ${songs}`;
    return el('button', {
      class: `row group ${isAlbum && showArtist ? 'group-with-artist' : ''}`,
      onclick: () => selectPath([...path, { field, value: entry.value, label: entry.label }]),
      oncontextmenu: (event) => {
        event.preventDefault();
        showGroupMenu(event, entry.tracks);
      },
    },
      el('span', { class: 'row-title' }, entry.label),
      el('span', { class: 'row-sub' }, summary),
      isAlbum && showArtist ? el('span', { class: 'row-artist' }, groupArtist) : null,
      el('span', { class: 'row-year' }, isAlbum
        ? (albumYear ? String(albumYear) : '')
        : plural(Library.groups('album', entry.tracks).length, 'album')),
      el('span', { class: 'row-genre' }, songs),
      el('span', { class: 'row-time' }, seconds ? formatTotal(seconds) : ''));
  }

  function renderGroups(field) {
    const tracks = baseTracks();
    visibleTracks = tracks;
    const entries = Library.groups(field, tracks);
    const isAlbum = field === 'album';
    const showArtist = isAlbum && !path.some((step) => step.field === 'artist');
    const total = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    const details = [plural(entries.length, field), plural(tracks.length, 'song')];
    if (total) details.push(formatTotal(total));

    const rows = el('div', { class: 'rows' });
    songList = virtualList(scroller, rows, entries.length, cssPixels('--row-height'), (i) => groupRow(entries[i], field, showArtist));

    const labels = isAlbum
      ? ['Album', showArtist ? 'Artist' : null, 'Year', 'Songs', 'Time']
      : ['Artist', 'Albums', 'Songs', 'Time'];
    const head = el('div', { class: `list-head group ${showArtist ? 'group-with-artist' : ''}` },
      ...labels.filter(Boolean).map((label, i) => el('span', { class: i === 0 ? 'column column-title' : 'column column-extra' }, label)));

    return [
      renderCrumbs(),
      el('h1', { class: 'heading' }, path[path.length - 1].label),
      el('p', { class: 'meta' }, details.join(' · ')),
      pageLinks(tracks),
      head,
      rows,
    ].filter(Boolean);
  }

  // Quiet links under a page's title for playing whatever it shows.
  function pageLinks(tracks) {
    if (!tracks.length) return null;
    return el('div', { class: 'page-links' },
      el('button', {
        class: 'page-link',
        onclick: () => {
          setShuffle(false);
          startList(visibleTracks, 0);
          closeTabsForAlbum();
        },
      }, icon('play'), 'Play'),
      el('button', {
        class: 'page-link',
        onclick: () => {
          setShuffle(true);
          startList(visibleTracks);
          closeTabsForAlbum();
        },
      }, icon('shuffle'), path.length || query ? 'Shuffle' : 'Shuffle All'),
      el('span', { class: 'selection-count' }, selection.size ? `${selection.size.toLocaleString()} selected` : ''));
  }

  // The title of a playlist being renamed, edited where it sits.
  function renderRenameField() {
    const field = el('input', { class: 'rename-input', value: path[0].label, 'aria-label': 'Playlist name', maxlength: '120' });
    const finish = (save) => {
      if (renamingId === null) return;
      const id = renamingId;
      renamingId = null;
      const name = field.value.trim();
      if (save && name) {
        UserData.renamePlaylist(id, name);
        path[0].label = name;
      }
      render();
    };
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
    field.addEventListener('blur', () => finish(true));
    requestAnimationFrame(() => field.select());
    return field;
  }

  function renderSongs() {
    const tracks = sortTracks(baseTracks());
    const total = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    const count = plural(tracks.length, query && !path.length ? 'result' : 'song');
    visibleTracks = tracks;

    let heading = query ? `Results for “${query}”` : 'All Songs';
    const details = [];
    if (path.length) {
      heading = path[path.length - 1].label;
      if (path[path.length - 1].field === 'album' && tracks.length) {
        const { groupArtist, albumYear } = tracks[0];
        if (!path.some((step) => step.field === 'artist')) details.push(groupArtist);
        if (albumYear && !path.some((step) => step.field === 'year')) details.push(String(albumYear));
      }
    }
    details.push(count);
    if (total) details.push(formatTotal(total));

    const isAlbumPage = path.length > 0 && path[path.length - 1].field === 'album' && tracks.length > 0;
    showLastPlayed = isAlbumPage;
    const rowHeight = cssPixels('--row-height');
    const rows = el('div', { class: 'rows' });
    const canReorder = inPlaylist() && UserData.findPlaylist(path[0].value) && !query && !sortColumn;
    const reorder = canReorder ? playlistReorder(tracks, rows, rowHeight) : null;
    songList = virtualList(scroller, rows, tracks.length, rowHeight, (i) => songRow(tracks[i], tracks, i, reorder));

    let columns = COLUMNS;
    const columnClass = isAlbumPage ? 'with-last-played' : '';
    if (isRecentlyPlayed()) columns = COLUMNS.map((column) => (column.label === 'Genre' ? LAST_PLAYED_COLUMN : column));
    if (isAlbumPage) columns = [...COLUMNS, LAST_PLAYED_COLUMN];
    const head = el('div', { class: `list-head ${columnClass}` }, ...columns.map((column) => {
      const active = sortColumn === column;
      return el('button', {
        class: `column ${column.className || ''}`,
        'aria-label': `Sort by ${column.label}`,
        'aria-pressed': active ? 'true' : 'false',
        onclick: () => sortBy(column),
      }, active ? `${column.label} ${sortDescending ? '▼' : '▲'}` : column.label);
    }), el('span', { class: 'column column-extra' }));

    return [
      renderCrumbs(),
      el('div', { class: 'page-head' },
        isAlbumPage ? Covers.element(tracks[0], 'cover cover-page') : null,
        el('div', { class: 'page-title' },
          renamingId !== null && inPlaylist() && path[0].value === renamingId
            ? renderRenameField()
            : el('h1', { class: 'heading' }, heading),
          el('p', { class: 'meta' }, details.join(' · ')),
          pageLinks(tracks))),
      tracks.length ? head : el('p', { class: 'empty' }, emptyMessage()),
      tracks.length ? el('div', { class: `rows-wrap ${columnClass}` }, rows, reorder ? reorder.line : null) : null,
    ].filter(Boolean);
  }

  function emptyMessage() {
    if (!query && !path.length && shelf.none) return shelf.none;
    if (query || !inPlaylist()) return 'Nothing in your library matches that.';
    const smart = ALL_SMART_LISTS.find((p) => p.value === path[0].value);
    return smart ? smart.empty : 'This playlist is empty. Right-click a song or album to add it.';
  }

  let renamingId = null;

  // Dragging rows up and down a playlist.
  function playlistReorder(tracks, rows, rowHeight) {
    const line = el('div', { class: 'drop-line', hidden: 'hidden' });
    const id = path[0].value;
    let from = null;
    let to = null;

    rows.addEventListener('dragover', (event) => {
      if (from === null) return;
      event.preventDefault();
      const offset = event.clientY - rows.getBoundingClientRect().top;
      to = Math.max(0, Math.min(tracks.length, Math.round(offset / rowHeight)));
      line.style.top = `${to * rowHeight}px`;
      line.hidden = false;
    });
    rows.addEventListener('drop', (event) => {
      if (from === null) return;
      event.preventDefault();
      const moved = [...tracks];
      const [track] = moved.splice(from, 1);
      moved.splice(to > from ? to - 1 : to, 0, track);
      UserData.setPlaylistOrder(id, moved);
      from = null;
      renderMain();
    });
    rows.addEventListener('dragend', () => {
      from = null;
      line.hidden = true;
    });

    return {
      line,
      start: (event, index) => {
        from = index;
        event.dataTransfer.effectAllowed = 'move';
      },
    };
  }

  // ---- Right-click menu and dialogs ----

  let openMenu = null;

  function closeMenu() {
    if (!openMenu) return;
    openMenu.remove();
    openMenu = null;
    document.querySelectorAll('[aria-expanded="true"]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  }

  // items: { label, action, detail?, checked?, radio?, accent? }, { heading } or 'line'.
  function showMenu(event, items, { width: fixedWidth, above = false } = {}) {
    closeMenu();
    const menu = el('div', { class: 'menu', role: 'menu' }, ...items.map((item) => {
      if (item === 'line') return el('div', { class: 'menu-line' });
      if (item.heading) return el('div', { class: 'menu-heading' }, item.heading);
      const isToggle = item.checked !== undefined;
      return el('button', {
        class: `menu-item ${item.accent ? 'menu-item-accent' : ''}`,
        role: item.radio ? 'menuitemradio' : (isToggle ? 'menuitemcheckbox' : 'menuitem'),
        'aria-checked': isToggle ? String(item.checked) : null,
        onclick: () => {
          closeMenu();
          item.action();
        },
      },
        el('span', { class: 'menu-mark' }, item.accent ? icon('plus') : (item.checked ? '✓' : '')),
        el('span', { class: 'menu-label' }, item.label, item.detail ? el('span', { class: 'menu-detail' }, item.detail) : null));
    }));
    if (fixedWidth) menu.style.width = `${fixedWidth}px`;
    document.body.append(menu);
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 8)}px`;
    const top = above ? event.clientY - height : event.clientY;
    menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
    openMenu = menu;
    menu.querySelector('button').focus();
  }

  function addToPlaylist(playlist, tracks) {
    const added = UserData.addToPlaylist(playlist.id, tracks);
    showToast(added ? `Added ${plural(added, 'song')} to ${playlist.name}.` : `Already in ${playlist.name}.`);
    if (inPlaylist() && path[0].value === playlist.id) renderMain();
  }

  function addToPlaylistItems(tracks) {
    return [
      { heading: 'Add to Playlist' },
      ...UserData.playlists.map((playlist) => ({ label: playlist.name, action: () => addToPlaylist(playlist, tracks) })),
      { label: 'New Playlist', accent: true, action: () => createPlaylist(tracks) },
    ];
  }

  // Right-clicking a selected song acts on the whole selection; any other song
  // acts on just that song. A setting shows ticked only if all of them have it.
  function showSongMenu(event, track) {
    if (!selection.has(track)) {
      clearSelection();
      refreshSelection();
    }
    const tracks = selection.size ? visibleTracks.filter((t) => selection.has(t)) : [track];
    const setting = (label, isOn, set) => {
      const allOn = tracks.every(isOn);
      return {
        label,
        checked: allOn,
        action: () => {
          tracks.forEach((t) => set(t, !allOn));
          updateNowHeart();
          renderMain();
        },
      };
    };
    const items = [
      { label: 'Play Next', action: () => playNext(tracks) },
      ...editMenuItems(tracks, visibleTracks),
      'line',
      setting('Favourite', UserData.isFavourite, UserData.setFavourite),
      setting('Remember Position', UserData.remembersPosition, UserData.setRemembersPosition),
      setting('Skip When Shuffling', UserData.skipsShuffle, UserData.setSkipsShuffle),
    ];
    if (inPlaylist() && UserData.findPlaylist(path[0].value)) {
      const id = path[0].value;
      items.push({
        label: tracks.length > 1 ? `Remove ${tracks.length} from This Playlist` : 'Remove from This Playlist',
        action: () => {
          tracks.forEach((t) => UserData.removeFromPlaylist(id, t));
          clearSelection();
          renderMain();
        },
      });
    }
    const title = tracks.length > 1 ? [{ heading: `${tracks.length.toLocaleString()} songs selected` }] : [];
    showMenu(event, [...title, ...items, 'line', ...addToPlaylistItems(tracks)]);
  }

  function showGroupMenu(event, tracks) {
    showMenu(event, [{ label: 'Play Next', action: () => playNext(tracks) }, ...editMenuItems(tracks), 'line', ...addToPlaylistItems(tracks)]);
  }

  function playNext(tracks) {
    Player.playNext(tracks);
    showToast(tracks.length > 1 ? `${plural(tracks.length, 'song')} playing next.` : `“${tracks[0].title}” is playing next.`);
  }

  // ---- Up Next ----

  let queueOpen = false;
  let queueList = null;

  function setQueueOpen(open) {
    queueOpen = open;
    document.documentElement.classList.toggle('queue-open', open);
    $('#queue').hidden = !open;
    $('#queue-toggle').setAttribute('aria-pressed', open ? 'true' : 'false');
    if (Host && miniPlayer) Host.setMiniQueue(open);
    renderQueue();
    // In the mini player the song list has just come back into view.
    filterLists.forEach((list) => list.draw(true));
    if (songList) songList.draw(true);
  }

  function renderQueue() {
    const panel = $('#queue');
    queueList = null;
    if (!queueOpen) return;
    const previousBox = panel.querySelector('.queue-list');
    const previousTop = previousBox ? previousBox.scrollTop : 0;

    const added = Player.upNext;
    const later = Player.laterInList;
    const items = [];
    if (added.length) {
      items.push({ heading: 'Added by You', clear: true });
      added.forEach((track, i) => items.push({ track, jump: () => Player.jumpToUpNext(i), remove: () => Player.removeFromUpNext(i) }));
    }
    if (later.length) {
      items.push({ heading: 'Next from This List' });
      later.forEach((track, i) => items.push({ track, jump: () => Player.jumpInList(i) }));
    }

    const title = el('h2', { class: 'queue-title' }, 'Up Next');
    if (!items.length) {
      panel.replaceChildren(title, el('p', { class: 'queue-empty' }, 'Nothing is coming up. Right-click a song and choose Play Next.'));
      return;
    }

    const rows = el('div', { class: 'queue-rows' });
    const box = el('div', { class: 'queue-list' }, rows);
    panel.replaceChildren(title, box);
    const rowHeight = cssPixels('--queue-row-height');
    queueList = virtualList(box, rows, items.length, rowHeight, (i) => {
      const item = items[i];
      if (item.heading) {
        return el('div', { class: 'queue-heading' },
          el('span', {}, item.heading),
          item.clear ? el('button', { class: 'queue-clear', onclick: () => Player.clearUpNext() }, 'Clear') : null);
      }
      return el('button', {
        class: 'queue-row',
        onclick: item.jump,
        oncontextmenu: (event) => {
          event.preventDefault();
          showMenu(event, item.remove
            ? [{ label: 'Remove from Up Next', action: item.remove }]
            : [{ label: 'Play Next', action: () => playNext([item.track]) }]);
        },
      },
        el('span', { class: 'queue-song' }, item.track.title),
        el('span', { class: 'queue-artist' }, item.track.artist));
    });
    box.addEventListener('scroll', () => queueList && queueList.draw());
    box.scrollTop = previousTop;
    queueList.draw(true);
  }

  // ---- Editing tags ----

  function editMenuItems(tracks, stepThrough = null) {
    if (!Host) return [];
    return [{ label: tracks.length > 1 ? `Edit ${tracks.length.toLocaleString()} Songs…` : 'Edit Song…', action: () => openEditor(tracks, stepThrough) }];
  }

  const isMp3 = (track) => /\.mp3$/i.test(track.path);

  function saveProblem(err) {
    if (/EACCES|EPERM|EROFS/.test(err.message)) return 'the drive can\'t be written to. Check it isn\'t read-only.';
    if (/ENOSPC/.test(err.message)) return 'the drive is full.';
    if (/ENOENT/.test(err.message)) return 'the file has gone. Check your drive is plugged in.';
    return err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

  async function readTagsOf(tracks) {
    const details = [];
    for (let i = 0; i < tracks.length; i += EDIT_READS_AT_ONCE) {
      const batch = tracks.slice(i, i + EDIT_READS_AT_ONCE);
      details.push(...await Promise.all(batch.map((t) => Host.readTags(t.file.fullPath))));
    }
    return details;
  }

  async function openEditor(chosen, stepThrough = null) {
    if (driveMissing) {
      showToast(missingMessage());
      return;
    }
    if (refreshing) {
      showToast('Checking your folder. Try again in a moment.');
      return;
    }
    const tracks = chosen.filter(isMp3);
    if (!tracks.length) {
      showToast('Only MP3 files can be edited so far.');
      return;
    }
    if (tracks.length > MAX_EDIT_SONGS) {
      showToast(`Edit up to ${MAX_EDIT_SONGS.toLocaleString()} songs at a time.`);
      return;
    }
    let details;
    try {
      details = await readTagsOf(tracks);
    } catch (err) {
      showToast(`Couldn't read those songs: ${err.message}`);
      return;
    }
    const steps = tracks.length === 1 && stepThrough ? stepThrough.filter(isMp3) : [];
    showEditor(tracks, details, chosen.length - tracks.length, steps.length > 1 ? steps : null);
  }

  function showEditor(chosenTracks, firstDetails, skipped, chosenSteps) {
    // The editor works on its own copies, since it updates them as it saves. The
    // library's songs must stay as they were so the next check notices the change.
    const copyOf = new Map([...chosenTracks, ...(chosenSteps || [])].map((t) => [t, { ...t }]));
    const firstTracks = chosenTracks.map((t) => copyOf.get(t));
    const stepList = chosenSteps ? chosenSteps.map((t) => copyOf.get(t)) : null;
    let tracks = firstTracks;
    let details = firstDetails;
    const edited = new Set(); // songs saved so far by stepping through them
    const single = tracks.length === 1;
    const dirty = new Set(); // boxes that have been changed, such as "album" or "3:title"
    let strip = false;
    let cover; // left undefined it stays as it is, null removes it, bytes replace it
    let coverUrl = null;
    let saving = false;
    let undo = null;

    const commonValue = (key) => {
      const first = details[0][key];
      return details.every((d) => d[key] === first) ? first : null;
    };

    const fieldBox = (field, value, dirtyKey, placeholder = '') => {
      const input = el('input', {
        class: 'editor-input',
        value,
        placeholder,
        'aria-label': field.label,
        inputmode: field.numeric ? 'numeric' : null,
        'data-numeric': field.numeric ? 'true' : null,
        maxlength: field.numeric ? '6' : null,
        oninput: () => dirty.add(dirtyKey),
      });
      return input;
    };

    const boxes = new Map();
    const fieldset = single ? SONG_FIELDS : ALBUM_FIELDS;
    const grid = el('div', { class: 'editor-grid' }, ...fieldset.map((field) => {
      const shared = commonValue(field.key);
      const input = fieldBox(field, shared ?? '', field.key, shared === null ? 'Multiple values' : '');
      boxes.set(field.key, input);
      return el('label', { class: 'editor-field', style: `grid-column: span ${field.span}` }, field.label, input);
    }));

    const compilation = el('input', { type: 'checkbox', onchange: () => dirty.add('compilation') });
    const sharedCompilation = commonValue('compilation');
    compilation.checked = sharedCompilation === true;
    compilation.indeterminate = sharedCompilation === null;
    grid.append(el('label', { class: 'editor-check' }, compilation, single ? 'Part of a compilation' : 'Compilation by various artists'));

    const rowBoxes = [];
    const songList = single ? null : el('div', { class: 'editor-rows' }, ...tracks.map((track, i) => {
      const row = {};
      const cells = ROW_FIELDS.map((field) => {
        row[field.key] = fieldBox(field, details[i][field.key], `${i}:${field.key}`, field.label);
        return row[field.key];
      });
      rowBoxes.push(row);
      return el('div', { class: 'editor-row' }, ...cells);
    }));

    // ---- The cover ----

    const coverTile = el('div', { class: 'editor-cover' });
    const coverNote = el('div', { class: 'editor-cover-note' });
    const sameAlbum = tracks.every((t) => t.albumKey === tracks[0].albumKey);

    function showCover() {
      coverTile.replaceChildren();
      coverNote.textContent = '';
      if (cover) {
        coverTile.append(el('img', { src: coverUrl, alt: '' }));
        coverNote.textContent = single ? 'New cover' : `New cover for ${plural(tracks.length, 'song')}`;
      } else if (cover === null) {
        coverTile.append('Drop an image here');
        coverNote.textContent = 'No cover. JPEG or PNG.';
      } else if (sameAlbum) {
        coverTile.append('No cover');
        Covers.forTrack(tracks[0]).then((url) => {
          if (url && cover === undefined) coverTile.replaceChildren(el('img', { src: url, alt: '' }));
        });
      } else {
        coverTile.append('Songs from different albums');
        coverNote.textContent = 'Their covers stay as they are unless you choose one.';
      }
    }

    function useCover(bytes) {
      if (coverUrl) URL.revokeObjectURL(coverUrl);
      cover = bytes;
      coverUrl = URL.createObjectURL(new Blob([bytes]));
      showCover();
    }

    coverTile.addEventListener('dragover', (event) => event.preventDefault());
    coverTile.addEventListener('drop', async (event) => {
      event.preventDefault();
      const [file] = event.dataTransfer.files;
      if (!file) return;
      if (!/^image\/(jpeg|png)$/.test(file.type)) {
        showToast('The cover must be a JPEG or PNG image.');
        return;
      }
      useCover(new Uint8Array(await file.arrayBuffer()));
    });

    // ---- Strip All Data ----

    const stripButton = el('button', { type: 'button', class: 'editor-strip' }, 'Strip All Data');
    const warning = el('div', { class: 'editor-warning', role: 'status' });
    const saveButton = el('button', { class: 'primary', type: 'submit' }, 'Save Changes');

    function showWording() {
      const files = plural(tracks.length, 'music file');
      stripButton.textContent = strip ? 'Undo Strip' : 'Strip All Data';
      stripButton.classList.toggle('editor-strip-on', strip);
      saveButton.textContent = strip ? 'Strip and Save' : 'Save Changes';
      if (stepList) {
        backLabel.textContent = strip ? 'Strip and Back' : 'Back';
        nextLabel.textContent = strip ? 'Strip and Next' : 'Next';
      }
      warning.textContent = strip
        ? `When you save, every tag and the cover will be removed from ${single ? 'this file' : `these ${files}`}, and only what you enter here gets written. Songs left without a title show their file name.`
        : `Saving updates ${files} on your drive${skipped ? `, skipping ${plural(skipped, 'song')} that aren't MP3s` : ''}. Boxes you leave alone stay as they are. Play counts, favourites and playlists stay with these songs.${stepList ? ' Back and Next save your changes as you go.' : ''}`;
    }

    const allBoxes = () => [...boxes.values(), ...rowBoxes.flatMap((row) => Object.values(row))];

    stripButton.addEventListener('click', () => {
      if (saving) return;
      strip = !strip;
      if (strip) {
        undo = { values: allBoxes().map((box) => box.value), placeholders: allBoxes().map((box) => box.placeholder), checked: compilation.checked, indeterminate: compilation.indeterminate, cover, coverUrl };
        allBoxes().forEach((box) => { box.value = ''; box.placeholder = box.getAttribute('aria-label'); });
        compilation.checked = false;
        compilation.indeterminate = false;
        cover = null;
      } else {
        allBoxes().forEach((box, i) => { box.value = undo.values[i]; box.placeholder = undo.placeholders[i]; });
        compilation.checked = undo.checked;
        compilation.indeterminate = undo.indeterminate;
        ({ cover, coverUrl } = undo);
      }
      showCover();
      showWording();
    });

    // ---- Saving ----

    function changesFor(index) {
      const changes = {};
      const fieldValues = single ? SONG_FIELDS : ALBUM_FIELDS;
      for (const { key } of fieldValues) {
        if (strip ? boxes.get(key).value.trim() : dirty.has(key)) changes[key] = boxes.get(key).value.trim();
      }
      if (rowBoxes.length) {
        for (const { key } of ROW_FIELDS) {
          const box = rowBoxes[index][key];
          if (strip ? box.value.trim() : dirty.has(`${index}:${key}`)) changes[key] = box.value.trim();
        }
      }
      if (strip ? compilation.checked : dirty.has('compilation')) changes.compilation = compilation.checked;
      return changes;
    }

    const progress = el('span', { class: 'editor-progress', role: 'status' });
    const cancelButton = el('button', { class: 'secondary', type: 'button', onclick: () => finish() }, stepList ? 'Close' : 'Cancel');
    const backLabel = el('span', {}, 'Back');
    const nextLabel = el('span', {}, 'Next');
    const backButton = el('button', { class: 'secondary editor-step', type: 'button', onclick: () => goTo(stepAt - 1) }, icon('back'), backLabel);
    const nextButton = el('button', { class: 'secondary editor-step editor-step-next', type: 'button', onclick: () => goTo(stepAt + 1) }, nextLabel, icon('back'));
    const title = el('h2', { class: 'dialog-title' });
    const dialog = el('dialog', { class: 'dialog editor' });
    let stepAt = stepList ? stepList.indexOf(firstTracks[0]) : -1;

    function showTitle() {
      if (stepList) title.textContent = `Edit Song · ${(stepAt + 1).toLocaleString()} of ${stepList.length.toLocaleString()}`;
      else title.textContent = single ? 'Edit Song' : `Edit ${tracks.length.toLocaleString()} Songs`;
    }

    function setBusy(busy) {
      saving = busy;
      dialog.classList.toggle('editor-saving', busy);
      saveButton.disabled = busy;
      cancelButton.disabled = busy;
      stripButton.disabled = busy;
      backButton.disabled = busy || stepAt <= 0;
      nextButton.disabled = busy || (stepList ? stepAt >= stepList.length - 1 : true);
    }

    // Saves to the files. Returns what failed, or null if something needs fixing first.
    async function writeChanges() {
      const bad = allBoxes().find((box) => box.dataset.numeric && !/^\d*$/.test(box.value.trim()));
      if (bad) {
        bad.focus();
        showToast(`${bad.getAttribute('aria-label')} needs to be a number.`);
        return null;
      }
      const requests = tracks.map((_, i) => changesFor(i));
      const failures = [];
      if (!strip && cover === undefined && requests.every((r) => !Object.keys(r).length)) return failures;

      setBusy(true);
      const playingEdited = Player.track && tracks.some((t) => t.path === Player.track.path);
      const wasPlaying = playingEdited && Player.isPlaying;
      if (playingEdited) Player.audio.pause();

      const batch = new Set(tracks.map((t) => t.path));
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        const showing = `Saving ${(i + 1).toLocaleString()} of ${tracks.length.toLocaleString()}`;
        progress.textContent = `${showing}…`;
        try {
          const request = { changes: requests[i], strip };
          if (cover !== undefined) request.cover = cover;
          const stats = await Host.writeTags(track.file.fullPath, request, (fraction) => {
            progress.textContent = `${showing}: ${Math.round(fraction * 100)}%`;
          });
          // A song's history moves as soon as its file has changed.
          const file = Host.makeFile({ fullPath: track.file.fullPath, name: track.file.name, ...stats });
          const newKey = await Library.keyFromFile({ file, path: track.path });
          const otherCopy = Library.tracks.some((t) => t.key === track.key && !batch.has(t.path));
          UserData.moveSong(track.key, newKey, otherCopy);
          // Stepping can come back to this song before the library is next updated.
          track.key = newKey;
          track.file = file;
          edited.add(track);
          if ((i + 1) % EDIT_SAVE_EVERY === 0) UserData.flush();
        } catch (err) {
          console.warn(`Could not save ${track.path}`, err);
          failures.push({ track, message: saveProblem(err) });
        }
      }
      UserData.flush();
      if (cover !== undefined) Covers.forgetAll();
      if (playingEdited) Player.reload(wasPlaying);
      progress.textContent = '';
      setBusy(false);
      return failures;
    }

    function failureMessage(failures, saved) {
      return `${saved ? `Saved ${plural(saved, 'song')}. ` : ''}Couldn't save ${failures.length === 1 ? `“${failures[0].track.title}”` : plural(failures.length, 'song')}: ${failures[0].message}`;
    }

    const finish = async () => {
      if (saving) return;
      dialog.close();
      dialog.remove();
      if (coverUrl) URL.revokeObjectURL(coverUrl);
      if (stepList && edited.size) {
        await afterEdits([...edited]);
        showToast(`Saved ${plural(edited.size, 'song')}.`);
      }
    };

    async function save() {
      const wasStrip = strip;
      const failures = await writeChanges();
      if (!failures) return;
      if (stepList) {
        if (failures.length) showToast(failureMessage(failures, 0));
        else finish();
        return;
      }
      if (!edited.size && !failures.length) {
        finish();
        return;
      }
      finish();
      await afterEdits(tracks);
      if (failures.length) showToast(failureMessage(failures, tracks.length - failures.length));
      else showToast(wasStrip ? `Stripped and saved ${plural(tracks.length, 'song')}.` : `Saved ${plural(tracks.length, 'song')}.`);
    }

    function fillBoxes() {
      for (const field of fieldset) {
        const box = boxes.get(field.key);
        box.value = details[0][field.key];
        box.placeholder = '';
      }
      compilation.checked = details[0].compilation;
      compilation.indeterminate = false;
    }

    // Saves this song, then shows another. A song that fails to save stays on screen.
    async function goTo(index) {
      if (saving || index < 0 || index >= stepList.length) return;
      const failures = await writeChanges();
      if (!failures) return;
      if (failures.length) {
        showToast(failureMessage(failures, 0));
        return;
      }
      setBusy(true);
      let next;
      try {
        next = await Host.readTags(stepList[index].file.fullPath);
      } catch (err) {
        setBusy(false);
        showToast(`Couldn't read “${stepList[index].title}”: ${saveProblem(err)}`);
        return;
      }
      tracks = [stepList[index]];
      details = [next];
      stepAt = index;
      dirty.clear();
      strip = false;
      undo = null;
      cover = undefined;
      fillBoxes();
      showTitle();
      showCover();
      showWording();
      setBusy(false);
      boxes.get('title').focus();
    }

    const form = el('form', {
      onsubmit: (event) => {
        event.preventDefault();
        save();
      },
    },
      el('div', { class: 'editor-head' },
        title,
        stripButton),
      el('div', { class: 'editor-body' },
        el('div', { class: 'editor-cover-column' },
          coverTile,
          coverNote,
          el('button', {
            class: 'secondary editor-cover-button',
            type: 'button',
            onclick: async () => {
              try {
                const bytes = await Host.pickImage();
                if (bytes) useCover(bytes);
              } catch (err) {
                showToast(saveProblem(err));
              }
            },
          }, 'Choose Image…'),
          el('button', {
            class: 'link-button editor-cover-remove',
            type: 'button',
            onclick: () => {
              cover = null;
              showCover();
            },
          }, 'Remove Cover')),
        grid),
      songList ? el('div', { class: 'editor-row editor-row-head' }, ...ROW_FIELDS.map((field) => el('span', {}, field.label))) : null,
      songList,
      warning,
      el('div', { class: 'dialog-buttons editor-buttons' },
        stepList ? el('div', { class: 'editor-steps' }, backButton, nextButton) : null,
        progress,
        cancelButton,
        saveButton));

    dialog.append(form);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish();
    });
    document.body.append(dialog);
    showTitle();
    showCover();
    showWording();
    setBusy(false);
    dialog.showModal();
  }

  // Brings the library, the player and the page up to date with what changed.
  async function afterEdits(tracks) {
    const wasOn = path;
    const firstPath = tracks[0].path;
    clearSelection();
    Covers.forgetAll();
    const folder = await Host.savedFolder();
    if (folder) await refreshLibrary(folder);

    const byPath = new Map(Library.tracks.map((t) => [t.path, t]));
    const heardPath = listening.track && listening.track.path;
    Player.relink(byPath);
    if (heardPath && byPath.has(heardPath)) listening.track = byPath.get(heardPath);

    // Renaming an album shouldn't throw you out of the page you were on.
    const edited = byPath.get(firstPath);
    if (edited && wasOn.length && !path.length) {
      if (shelfFor(edited) !== shelf) setShelf(shelfFor(edited));
      selectPath([{ field: 'album', value: edited.albumKey, label: edited.album }]);
    } else {
      render();
    }
  }

  function showPlaylistMenu(event, entry) {
    showMenu(event, [
      {
        label: 'Rename',
        action: () => {
          renamingId = entry.value;
          sortColumn = null;
          selectPath([{ field: 'playlist', value: entry.value, label: entry.label }]);
        },
      },
      {
        label: 'Delete',
        action: async () => {
          const yes = await askDialog({
            title: `Delete “${entry.label}”?`,
            message: 'This removes the playlist only. Your music files aren\'t touched.',
            confirm: 'Delete',
          });
          if (!yes) return;
          UserData.deletePlaylist(entry.value);
          if (inPlaylist() && path[0].value === entry.value) path = [];
          render();
        },
      },
    ]);
  }

  // From a song's menu it asks for a name and leaves you where you are. From
  // the sidebar it opens the new playlist with its title ready to edit.
  async function createPlaylist(tracks = []) {
    if (tracks.length) {
      const name = await askDialog({ title: 'New playlist', input: '', confirm: 'Create' });
      if (!name) return;
      addToPlaylist(UserData.createPlaylist(name), tracks);
      renderSide();
    } else {
      const playlist = UserData.createPlaylist('Untitled Playlist');
      renamingId = playlist.id;
      sortColumn = null;
      selectPath([{ field: 'playlist', value: playlist.id, label: playlist.name }]);
    }
  }

  // Resolves to the typed text or true when confirmed, and null when cancelled.
  function askDialog({ title, message, input, confirm }) {
    return new Promise((resolve) => {
      const hasInput = input !== undefined;
      const field = hasInput
        ? el('input', { class: 'dialog-input', value: input, 'aria-label': title, maxlength: '120', required: 'required' })
        : null;
      const dialog = el('dialog', { class: 'dialog' });
      const finish = (value) => {
        dialog.close();
        dialog.remove();
        resolve(value);
      };
      const form = el('form', {
        onsubmit: (event) => {
          event.preventDefault();
          if (!hasInput) finish(true);
          else if (field.value.trim()) finish(field.value.trim());
        },
      },
        el('h2', { class: 'dialog-title' }, title),
        message ? el('p', { class: 'dialog-message' }, message) : null,
        field,
        el('div', { class: 'dialog-buttons' },
          el('button', { class: 'secondary', type: 'button', onclick: () => finish(null) }, 'Cancel'),
          el('button', { class: 'primary', type: 'submit' }, confirm)));
      dialog.append(form);
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        finish(null);
      });
      document.body.append(dialog);
      dialog.showModal();
      if (field) field.select();
    });
  }

  function renderWelcome() {
    const actions = [];
    if (savedFolder) {
      actions.push(el('button', { class: 'primary', onclick: reopenSaved }, `Reopen “${savedFolder.name}”`));
      actions.push(el('button', { class: 'secondary', onclick: pickFolder }, 'Choose another folder'));
    } else {
      actions.push(el('button', { class: 'primary', onclick: pickFolder }, 'Choose your music folder'));
    }
    return [
      el('div', { class: 'welcome' },
        el('h1', {}, Host ? 'Your music' : 'Your music, in your browser'),
        el('p', {}, 'Pick a folder and it will be organised by artist, album, genre and year from the tags in your files. MP3, FLAC, Ogg, Opus, M4A and WAV are supported.'),
        el('div', { class: 'actions' }, ...actions),
        el('p', { class: 'note' }, Host || SUPPORTS_PICKER
          ? 'Nothing leaves your computer.'
          : 'Your browser may describe this as “uploading” files. Nothing leaves your computer. It will ask for the folder again on each visit.')),
    ];
  }

  function driveName() {
    const onDrive = /\/media\/[^/]+\/([^/]+)/.exec(savedFolder.path);
    return onDrive ? onDrive[1] : savedFolder.name;
  }

  const missingMessage = () => `Your music drive isn't connected. Plug in “${driveName()}” to play this.`;

  function renderDriveNotice() {
    return el('div', { class: 'notice notice-warning', role: 'status' },
      el('div', { class: 'notice-text' },
        el('div', { class: 'notice-title' }, 'Your music drive isn\'t connected'),
        el('div', { class: 'notice-detail' }, `You can still browse. Songs will play again as soon as “${driveName()}” is back.`)),
      el('button', {
        class: 'secondary notice-button',
        onclick: async () => {
          await checkFolder();
          if (driveMissing) showToast(`Still can't find “${driveName()}”. Check it's plugged in.`);
        },
      }, 'Try Again'));
  }

  function showNewMusic() {
    const found = Library.tracks.find((t) => newMusicPaths.has(t.path));
    if (found && shelfFor(found) !== shelf) setShelf(shelfFor(found));
    selectPath([{ field: 'playlist', value: NEW_MUSIC_LIST, label: 'New Music' }]);
  }

  function renderScanNotice() {
    const { newSongs, changed, removed } = scanReport;
    const albums = Library.groups('album', newSongs);
    const others = [];
    if (changed) others.push(`${plural(changed, 'song')} changed`);
    if (removed) others.push(`${plural(removed, 'song')} removed`);
    const summary = others.join(', ') || 'Nothing changed or removed';

    let detail = `${summary}.`;
    if (albums.length === 1) detail = `${albums[0].label} by ${albums[0].tracks[0].groupArtist}. ${detail}`;
    const title = newSongs.length
      ? `Scan finished: ${plural(albums.length, 'new album')}, ${plural(newSongs.length, 'song')}`
      : 'Scan finished';
    return el('div', { class: 'notice', role: 'status' },
      el('div', { class: 'notice-text' },
        el('div', { class: 'notice-title' }, title),
        el('div', { class: 'notice-detail' }, detail)),
      newSongs.length ? el('button', { class: 'secondary notice-button', onclick: showNewMusic }, 'Show New Music') : null,
      el('button', {
        class: 'link-button notice-dismiss',
        onclick: () => {
          scanReport = null;
          renderMain();
        },
      }, 'Dismiss'));
  }

  // ---- The iPod ----

  const formatGb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;

  function renderDevices() {
    const box = $('#devices');
    box.hidden = !ipod;
    if (!ipod) return;
    const ready = ipod.state === 'ready';
    const name = ready ? (ipod.contents && ipod.contents.name) || ipod.label : 'iPod';
    box.replaceChildren(
      el('h2', { class: 'playlists-heading' }, 'Devices'),
      el('div', { class: `device ${ipodOpen ? 'device-open' : ''}` },
        el('button', {
          class: 'device-name',
          title: name,
          'aria-current': ipodOpen ? 'true' : 'false',
          onclick: () => {
            ipodOpen = true;
            scroller.scrollTop = 0;
            clearSelection();
            renderDevices();
            renderMain();
          },
        }, name),
        ready ? el('button', {
          class: 'device-eject',
          title: 'Eject',
          'aria-label': `Eject ${name}`,
          onclick: ejectIpod,
        }, icon('eject')) : null));
  }

  async function ejectIpod() {
    try {
      await Host.ejectIpod();
      await checkIpod();
      showToast('Your iPod is safe to unplug.');
    } catch (err) {
      showToast(saveProblem(err));
    }
  }

  async function checkIpod() {
    let found = null;
    try {
      found = await Host.ipod();
    } catch (err) {
      console.warn('Could not check for an iPod', err);
    }
    const stamp = found ? `${found.state}|${found.mount}|${found.lastSynced}|${found.free}` : '';
    if (stamp === ipodStamp) return;
    ipodStamp = stamp;
    ipod = found;
    if (!ipod) ipodOpen = false;
    ipodSongs = ipod && ipod.state === 'ready' ? await Host.ipodSongs() : [];
    renderDevices();
    if (ipodOpen || !ipod) renderMain();
  }

  // ---- Syncing the iPod ----

  const matchKey = (album, title) => `${Library.fold(album || '')}\0${Library.fold(title || '')}`;
  const canSyncTrack = (track) => /\.mp3$/i.test(track.path);

  function untickedGroups() {
    try {
      return new Set(JSON.parse(localStorage.getItem(UNTICKED_KEY) || '[]'));
    } catch {
      return new Set();
    }
  }

  function setUnticked(unticked) {
    try {
      localStorage.setItem(UNTICKED_KEY, JSON.stringify([...unticked]));
    } catch {
      // Storage can be blocked; the choice just won't be remembered.
    }
  }

  // What can go on the iPod: all music together, then each show and book.
  function syncGroups() {
    const groups = [];
    const music = tracksIn('music').filter(canSyncTrack);
    if (music.length) groups.push({ id: 'music', label: 'Music', word: 'song', tracks: music });
    for (const { id, word } of [{ id: 'podcasts', word: 'episode' }, { id: 'audiobooks', word: 'file' }]) {
      for (const group of Library.groups('album', tracksIn(id).filter(canSyncTrack), { byName: true })) {
        groups.push({ id: `${id}:${group.value}`, label: group.label, word, tracks: group.tracks });
      }
    }
    return groups;
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

  // What a sync would do: the iPod ends up holding exactly what's ticked.
  function planSync() {
    const unticked = untickedGroups();
    const groups = syncGroups();
    const wanted = groups.filter((group) => !unticked.has(group.id)).flatMap((group) => group.tracks);
    const wantedKeys = new Set(wanted.map((t) => matchKey(t.album, t.title)));
    const onIpod = new Set(ipodSongs.map((t) => matchKey(t.album, t.title)));
    const additions = wanted.filter((t) => !onIpod.has(matchKey(t.album, t.title)));
    const removals = ipodSongs.filter((t) => !wantedKeys.has(matchKey(t.album, t.title)));
    const numbers = numbersFor(wanted);
    const songsThere = new Map(ipodSongs.map((t) => [matchKey(t.album, t.title), t]));
    const updates = wanted.flatMap((track) => {
      const there = songsThere.get(matchKey(track.album, track.title));
      if (!there) return [];
      const want = numbers.get(track);
      const same = want.trackNo === there.trackNo && want.trackTotal === there.trackTotal
        && want.discNo === there.discNo && want.discTotal === there.discTotal;
      return same ? [] : [{ path: there.path, ...want }];
    });
    const addBytes = additions.reduce((sum, t) => sum + t.file.size, 0);
    const skipped = Library.tracks.length - tracksIn('music').filter(canSyncTrack).length
      - tracksIn('podcasts').filter(canSyncTrack).length - tracksIn('audiobooks').filter(canSyncTrack).length;
    return { groups, unticked, additions, removals, updates, numbers, addBytes, skipped };
  }

  const pendingPlays = () => ipodSongs.reduce((sum, t) => sum + Math.max(0, t.plays - UserData.ipodPlaysCounted(t.path)), 0);

  function bringBackPlays() {
    let brought = 0;
    for (const song of ipodSongs) {
      if (song.plays > UserData.ipodPlaysCounted(song.path)) {
        brought += UserData.addIpodPlays(song.path, Library.keyFor(song), song.plays, song.lastPlayed);
      }
    }
    UserData.flush();
    return brought;
  }

  async function startSync() {
    // The library decides what stays. Without one, a sync would empty the iPod.
    if (driveMissing || refreshing || scanning || !Library.tracks.length) {
      showToast(driveMissing ? missingMessage() : 'Your library isn\'t ready. Try again in a moment.');
      return;
    }
    const plan = planSync();
    if (!plan.additions.length && !plan.removals.length && !plan.updates.length) {
      const brought = bringBackPlays();
      showToast(brought ? `Brought back ${plural(brought, 'play')}. Your iPod is already up to date.` : 'Your iPod is already up to date.');
      renderMain();
      return;
    }
    if (plan.removals.length) {
      const yes = await askDialog({
        title: `Remove ${plural(plan.removals.length, 'song')} from your iPod?`,
        message: `This sync removes ${plural(plan.removals.length, 'song')} and adds ${plural(plan.additions.length, 'song')}, so your iPod matches what's ticked. Removed songs are deleted from the iPod and can't be brought back from it. Your library's own files aren't touched, and your iPod's plays are brought back first.`,
        confirm: `Remove ${plural(plan.removals.length, 'song')} and Sync`,
      });
      if (!yes) return;
    }

    bringBackPlays();
    ipodResult = null;
    ipodSync = { phase: 'preparing' };
    renderMain();
    try {
      const result = await Host.syncIpod({
        removals: plan.removals.map((t) => t.path),
        updates: plan.updates,
        additions: plan.additions.map((t) => ({
          fullPath: t.file.fullPath,
          title: t.title,
          artist: t.artist,
          albumArtist: t.albumArtist,
          album: t.album,
          albumKey: t.albumKey,
          genre: t.genre,
          year: t.year,
          ...plan.numbers.get(t),
          compilation: t.compilation,
          duration: t.duration || 0,
          size: t.file.size,
        })),
      }, (progress) => {
        ipodSync = { ...ipodSync, ...progress };
        if (ipodOpen) renderMain();
      });
      ipodResult = result;
    } catch (err) {
      ipodResult = { problem: saveProblem(err) };
    }
    ipodSync = null;
    ipodStamp = '';
    await checkIpod();
    renderMain();
  }

  function renderSyncProgress() {
    const { phase, done = 0, total = 0, removed } = ipodSync;
    const titles = {
      preparing: 'Getting ready…',
      removed: `Removed ${plural(removed || 0, 'song')}. Saving…`,
      saving: 'Saving your iPod\'s music list…',
      copying: `Copying ${done.toLocaleString()} of ${total.toLocaleString()}`,
    };
    return [el('div', { class: 'notice sync-progress', role: 'status' },
      el('div', { class: 'notice-text' },
        el('div', { class: 'notice-title' }, 'Syncing. Don\'t unplug your iPod.'),
        el('div', { class: 'notice-detail' }, titles[phase]),
        progressBar(total ? (done / total) * 100 : 0)),
      el('button', {
        class: 'link-button notice-dismiss',
        onclick: () => {
          Host.stopIpodSync();
          showToast('Stopping after this song.');
        },
      }, 'Stop After This Song'))];
  }

  function renderSyncResult() {
    if (ipodResult.problem) {
      return el('div', { class: 'notice notice-warning', role: 'status' },
        el('div', { class: 'notice-text' },
          el('div', { class: 'notice-title' }, 'The sync didn\'t finish'),
          el('div', { class: 'notice-detail' }, ipodResult.problem)));
    }
    const { added, removed, updated, failures } = ipodResult;
    const parts = [`Added ${plural(added, 'song')}`, `removed ${plural(removed, 'song')}`];
    if (updated) parts.push(`updated ${plural(updated, 'song')}`);
    return el('div', { class: 'notice', role: 'status' },
      el('div', { class: 'notice-text' },
        el('div', { class: 'notice-title' }, 'Sync finished'),
        el('div', { class: 'notice-detail' }, `${parts.join(', ')}. Eject before you unplug it.`),
        failures.length ? el('div', { class: 'notice-detail' }, `Couldn't copy ${plural(failures.length, 'song')}, starting with “${failures[0].title}”: ${failures[0].message}`) : null));
  }

  function renderIpodSync() {
    if (ipodSync) return renderSyncProgress();
    if (!Library.tracks.length || driveMissing) {
      return [el('p', { class: 'empty ipod-section' }, driveMissing ? 'Connect your music drive to sync.' : 'Choose a music folder to sync.')];
    }
    const plan = planSync();
    const removedBytes = removalBytes(plan);
    const freeAfter = ipod.free + removedBytes - plan.addBytes;
    const fits = freeAfter >= IPOD_SPARE_BYTES;
    const played = pendingPlays();

    const rows = plan.groups.map((group) => {
      const bytes = group.tracks.reduce((sum, t) => sum + t.file.size, 0);
      const box = el('input', {
        type: 'checkbox',
        onchange: () => {
          const unticked = untickedGroups();
          if (box.checked) unticked.delete(group.id);
          else unticked.add(group.id);
          setUnticked(unticked);
          renderMain();
        },
      });
      box.checked = !plan.unticked.has(group.id);
      return el('label', { class: 'sync-row' }, box,
        el('span', { class: 'sync-row-name' }, group.label),
        el('span', { class: 'sync-row-detail' }, `${plural(group.tracks.length, group.word)} · ${formatGb(bytes)}`));
    });

    const summary = [
      ['Add', plan.additions.length ? `${plural(plan.additions.length, 'song')}, ${formatGb(plan.addBytes)}` : 'Nothing'],
      ['Remove', plan.removals.length ? `${plural(plan.removals.length, 'song')}, ${formatGb(removedBytes)}` : 'Nothing'],
      ...(plan.updates.length ? [['Update', plural(plan.updates.length, 'song')]] : []),
      ['Bring back', played ? `${plural(played, 'play')} from your iPod` : 'No new plays'],
      ['Free after sync', fits ? formatGb(freeAfter) : `Short of ${formatGb(IPOD_SPARE_BYTES - freeAfter)}`],
    ];
    const nothingToDo = !plan.additions.length && !plan.removals.length && !plan.updates.length && !played;
    return [
      ipodResult ? renderSyncResult() : null,
      el('div', { class: 'sync-layout' },
        el('div', { class: 'sync-list' },
          el('h2', { class: 'shelf-heading' }, 'What Goes on Your iPod'),
          ...rows,
          plan.skipped > 0 ? el('p', { class: 'sync-note' }, `${plural(plan.skipped, 'song')} in other formats can't go on an iPod yet, so ${plan.skipped === 1 ? 'it stays' : 'they stay'} off.`) : null),
        el('div', { class: 'sync-summary' },
          el('h2', { class: 'shelf-heading' }, 'This Sync'),
          ...summary.map(([label, value]) => el('div', { class: 'sync-line' }, el('span', { class: 'sync-line-label' }, label), el('span', { class: 'sync-line-value' }, value))),
          plan.removals.length ? el('p', { class: 'sync-warning' }, `Songs that aren't ticked or in your library get deleted from the iPod. You'll be asked to confirm.`) : null,
          fits ? null : el('p', { class: 'sync-warning' }, 'Untick something to make room.'),
          el('button', {
            class: 'hero-action sync-button',
            disabled: !fits || nothingToDo ? 'disabled' : null,
            onclick: startSync,
          }, el('span', { class: 'hero-action-label' }, nothingToDo ? 'Up to Date' : 'Sync Now')))),
    ].filter(Boolean);
  }

  // The database lists each song's size, but only the summary keeps it, so
  // removals are estimated from what share of the iPod's songs are going.
  function removalBytes(plan) {
    if (!plan.removals.length) return 0;
    const { kinds } = ipod.contents;
    const songs = kinds.music.songs + kinds.podcasts.songs + kinds.audiobooks.songs;
    const bytes = kinds.music.bytes + kinds.podcasts.bytes + kinds.audiobooks.bytes;
    return songs ? (bytes * plan.removals.length) / songs : 0;
  }

  // Plugged in, but not available as a drive yet.
  function renderIpodWaiting() {
    const messages = {
      ejected: ['Your iPod has been ejected', 'It\'s safe to unplug. To use it here again, unplug it and plug it back in.', null],
      unmounted: ['Your iPod is plugged in', 'It hasn\'t opened as a drive yet.', 'Open iPod'],
      starting: ['Your iPod is starting up', 'This can take a few seconds while its disk spins up.', null],
    };
    const [title, detail, action] = messages[ipod.state];
    return [
      el('h1', { class: 'heading page-title-only' }, 'iPod'),
      el('div', { class: 'notice' },
        el('div', { class: 'notice-text' },
          el('div', { class: 'notice-title' }, title),
          el('div', { class: 'notice-detail' }, detail)),
        action ? el('button', {
          class: 'secondary notice-button',
          onclick: async () => {
            try {
              await Host.mountIpod();
              await checkIpod();
            } catch (err) {
              showToast(saveProblem(err));
            }
          },
        }, action) : null),
    ];
  }

  function renderIpodPage() {
    if (ipod.state !== 'ready') return renderIpodWaiting();
    const { contents, capacity, free, model } = ipod;
    const name = (contents && contents.name) || ipod.label;
    const used = capacity - free;
    const synced = new Date(ipod.lastSynced).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    const head = [
      el('h1', { class: 'heading' }, name),
      el('p', { class: 'meta' }, [model, `${Math.round(capacity / 1e9)} GB`, `Last changed ${synced}`].join(' · ')),
    ];
    if (!contents) {
      return [...head, el('p', { class: 'empty' }, 'This iPod\'s music list couldn\'t be read. It may be a model the app doesn\'t support yet.')];
    }

    const parts = [
      { label: 'Music', word: 'song', count: contents.kinds.music.songs, bytes: contents.kinds.music.bytes, className: 'meter-music' },
      { label: 'Podcasts', word: 'episode', count: contents.kinds.podcasts.songs, bytes: contents.kinds.podcasts.bytes, className: 'meter-podcasts' },
      { label: 'Audiobooks', word: 'book', count: contents.kinds.audiobooks.songs, bytes: contents.kinds.audiobooks.bytes, className: 'meter-books' },
    ];
    const media = parts.reduce((sum, part) => sum + part.bytes, 0);
    const other = Math.max(0, used - media);
    const percent = (bytes) => `width: ${(bytes / capacity) * 100}%`;
    const hours = Math.round(contents.milliseconds / 3.6e6);

    return [
      ...head,
      el('div', { class: 'meter', role: 'img', 'aria-label': `${formatGb(used)} used, ${formatGb(free)} free` },
        ...parts.map((part) => el('span', { class: part.className, style: percent(part.bytes) })),
        el('span', { class: 'meter-other', style: percent(other) })),
      el('div', { class: 'meter-key' },
        ...parts.map((part) => el('span', { class: 'meter-key-item' }, el('span', { class: `meter-dot ${part.className}` }), `${part.label} ${formatGb(part.bytes)}`)),
        el('span', { class: 'meter-key-item' }, el('span', { class: 'meter-dot meter-other' }), `Other ${formatGb(other)}`),
        el('span', { class: 'meter-free' }, `${formatGb(free)} free`)),
      el('div', { class: 'ipod-grid' },
        ...parts.map((part) => el('div', { class: 'ipod-card' },
          el('div', { class: 'ipod-card-number' }, part.count.toLocaleString()),
          el('div', { class: 'ipod-card-label' }, part.count === 1 ? part.word : `${part.word}s`),
          el('div', { class: 'ipod-card-detail' }, part.label))),
        el('div', { class: 'ipod-card' },
          el('div', { class: 'ipod-card-number' }, hours.toLocaleString()),
          el('div', { class: 'ipod-card-label' }, hours === 1 ? 'hour' : 'hours'),
          el('div', { class: 'ipod-card-detail' }, `${contents.plays.toLocaleString()} ${contents.plays === 1 ? 'play' : 'plays'} on the iPod`))),
      ...renderIpodSync(),
      el('h2', { class: 'shelf-heading' }, 'Playlists on Your iPod'),
      contents.playlists.length
        ? el('ul', { class: 'ipod-playlists' }, ...contents.playlists.map((list) => el('li', { class: 'ipod-playlist' },
          el('span', {}, list.name),
          el('span', { class: 'ipod-playlist-count' }, plural(list.songs, 'song')))))
        : el('p', { class: 'empty' }, 'No playlists.'),
    ];
  }

  function renderMain() {
    songList = null;
    visibleTracks = [];
    if (ipodOpen && ipod) {
      content.replaceChildren(...renderIpodPage());
      return;
    }
    if (Library.tracks.length) {
      if (shelf.id === 'podcasts') content.replaceChildren(...renderPodcasts());
      else if (shelf.id === 'audiobooks') content.replaceChildren(...renderAudiobooks());
      else {
        const field = nextField();
        content.replaceChildren(...(field ? renderGroups(field) : renderSongs()));
      }
      if (scanReport) content.prepend(renderScanNotice());
      if (driveMissing) content.prepend(renderDriveNotice());
      if (songList) songList.draw(true);
    } else if (scanning) {
      content.replaceChildren();
    } else {
      content.replaceChildren(...renderWelcome());
    }
  }

  function render() {
    const started = performance.now();
    const inShelf = tracksIn(shelf.id);
    matched = query ? Library.search(query).filter((t) => shelfFor(t) === shelf) : inShelf;
    renderShelfSwitch();
    renderSide();
    renderDevices();
    renderMain();
    lastRender = performance.now();
    lastRenderCost = lastRender - started;
  }

  // Sorting a very large library takes time, so while a scan is running the
  // page redraws less often the longer each redraw takes.
  function renderDuringScan() {
    if (performance.now() - lastRender >= Math.max(MIN_RENDER_GAP_MS, lastRenderCost * 10)) render();
  }

  // ---- Loading a folder ----

  async function load(entries, folderName) {
    scanning = true;
    path = [];
    const status = $('#scan-status');

    const result = await Library.ingest(entries, (stats) => {
      status.textContent = `Reading tags: ${stats.done.toLocaleString()} of ${stats.total.toLocaleString()}`;
      renderDuringScan();
    });
    if (result.cancelled) return result;

    scanning = false;
    status.textContent = `${plural(result.total, 'song')} in ${folderName}`;
    $('#manage-library').hidden = false;
    if (!result.total) showToast(`No music files found in ${folderName}.`);
    render();
    return result;
  }

  async function walk(directory, path, entries, onFound) {
    try {
      for await (const handle of directory.values()) {
        if (handle.name.startsWith('.')) continue;
        const childPath = `${path}/${handle.name}`;
        if (handle.kind === 'directory') {
          await walk(handle, childPath, entries, onFound);
        } else if (Library.isAudio(handle.name)) {
          entries.push({ file: await handle.getFile(), path: childPath });
          onFound(entries.length);
        }
      }
    } catch (err) {
      console.warn(`Could not read ${path}`, err);
    }
  }

  async function openHandle(handle) {
    scanning = true;
    render();
    const status = $('#scan-status');
    status.textContent = 'Looking for music…';
    const entries = [];
    await walk(handle, handle.name, entries, (count) => {
      status.textContent = `Looking for music: ${count.toLocaleString()} found`;
    });
    await load(entries, handle.name);
  }

  async function openHostFolder(folder) {
    setDriveMissing(false);
    scanning = true;
    render();
    const status = $('#scan-status');
    status.textContent = 'Looking for music…';
    const entries = await Host.scan((count) => {
      status.textContent = `Looking for music: ${count.toLocaleString()} found`;
    });
    await load(entries, folder.name);
    await saveLibrary(folder);
  }

  async function saveLibrary(folder) {
    const items = Library.exportTracks().map(({ file, ...item }) => ({
      ...item,
      fileInfo: { fullPath: file.fullPath, name: file.name, size: file.size, lastModified: file.lastModified },
    }));
    await DB.put('kv', 'library', { folderPath: folder.path, items });
  }

  // Shows the library saved last time straight away, or returns false if there isn't one.
  async function restoreLibrary(folder) {
    const saved = await DB.get('kv', 'library');
    if (!saved || saved.folderPath !== folder.path || !saved.items.length) return false;
    Library.restore(saved.items.map(({ fileInfo, ...item }) => ({ ...item, file: Host.makeFile(fileInfo) })));
    $('#scan-status').textContent = `${plural(saved.items.length, 'song')} in ${folder.name}`;
    $('#manage-library').hidden = false;
    render();
    return true;
  }

  // Checks the folder and only touches the library if songs changed. A song
  // that's been moved or retagged counts as changed rather than new and removed.
  async function refreshLibrary(folder, { report = false } = {}) {
    if (refreshing) return;
    refreshing = true;
    const status = $('#scan-status');
    const summary = `${plural(Library.tracks.length, 'song')} in ${folder.name}`;
    status.textContent = report ? 'Scanning your folder…' : `${summary} · checking for changes…`;

    try {
      const entries = await Host.scan((count) => {
        if (report) status.textContent = `Scanning your folder: ${count.toLocaleString()} found`;
      });
      const current = await Host.savedFolder();
      if (!current || current.path !== folder.path) return;
      // A drive pulled out mid-scan looks like an empty folder, so never believe that.
      if (!current.available || (!entries.length && Library.tracks.length)) {
        status.textContent = summary;
        if (!current.available) setDriveMissing(true);
        else if (report) showToast(`No music found in ${folder.name}, so your library was left as it is.`);
        return;
      }

      const before = Library.tracks;
      const known = new Map(before.map((t) => [t.path, t.file]));
      const unchanged = entries.length === known.size && entries.every(({ path: filePath, file }) => {
        const previous = known.get(filePath);
        return previous && previous.size === file.size && previous.lastModified === file.lastModified;
      });
      if (unchanged) {
        status.textContent = summary;
        if (report) showToast('Scan finished: nothing has changed.');
        return;
      }

      const result = await Library.ingest(entries, (stats) => {
        status.textContent = `Updating library: ${stats.done.toLocaleString()} of ${stats.total.toLocaleString()}`;
      }, { keepCurrent: true });
      if (result.cancelled) return;

      status.textContent = `${plural(result.total, 'song')} in ${folder.name}`;
      if (report) {
        scanReport = describeChanges(before);
        if (inPlaylist() && path[0].value === NEW_MUSIC_LIST) path = [];
      }
      if (!inPlaylist() && !Library.within(path).length) path = [];
      render();
      await saveLibrary(folder);
    } finally {
      refreshing = false;
    }
  }

  function describeChanges(before) {
    const after = Library.tracks;
    const oldKeys = new Set(before.map((t) => t.key));
    const newKeys = new Set(after.map((t) => t.key));
    const oldFiles = new Map(before.map((t) => [t.path, t.file]));
    const newSongs = after.filter((t) => !oldKeys.has(t.key));
    newMusicPaths = new Set(newSongs.map((t) => t.path));
    const changed = after.filter((t) => {
      if (!oldKeys.has(t.key)) return false;
      const previous = oldFiles.get(t.path);
      return !previous || previous.size !== t.file.size || previous.lastModified !== t.file.lastModified;
    }).length;
    return { newSongs, changed, removed: before.filter((t) => !newKeys.has(t.key)).length };
  }

  async function scanFolder() {
    if (driveMissing) {
      showToast(`Can't scan: “${driveName()}” isn't connected.`);
      return;
    }
    if (refreshing) {
      showToast('Already checking your folder.');
      return;
    }
    scanReport = null;
    const folder = await Host.savedFolder();
    if (folder) await refreshLibrary(folder, { report: true });
  }

  function setDriveMissing(missing) {
    if (missing === driveMissing) return;
    driveMissing = missing;
    document.documentElement.classList.toggle('drive-missing', missing);
    if (missing) Player.audio.pause();
    else Covers.forgetAll();
    renderMain();
  }

  // Notices the drive going and coming back, whichever way it happens.
  async function checkFolder() {
    if (!savedFolder || refreshing || !Library.tracks.length) return;
    const folder = await Host.savedFolder();
    const available = Boolean(folder && folder.available);
    if (available === !driveMissing) return;
    setDriveMissing(!available);
    if (available) await refreshLibrary(folder);
  }

  async function pickFolder() {
    if (Host) {
      const folder = await Host.pickFolder();
      if (folder) {
        savedFolder = folder;
        await openHostFolder(folder);
      }
      return;
    }
    if (!SUPPORTS_PICKER) {
      $('#folder-input').click();
      return;
    }
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'music', mode: 'read' });
    } catch (err) {
      // Some pages aren't allowed to use the picker; the plain file dialog still works.
      if (err.name !== 'AbortError') $('#folder-input').click();
      return;
    }
    savedFolder = handle;
    await DB.put('kv', 'folder', handle);
    await openHandle(handle);
  }

  async function reopenSaved() {
    if (Host) {
      const folder = await Host.savedFolder();
      if (folder && folder.available) await openHostFolder(folder);
      else showToast(`Can't find “${savedFolder.name}”. If it's on a USB drive, check it's plugged in.`);
      return;
    }
    const permission = await savedFolder.requestPermission({ mode: 'read' });
    if (permission === 'granted') await openHandle(savedFolder);
    else showToast('The browser needs your permission to read that folder.');
  }

  function onFolderInput(event) {
    const files = Array.from(event.target.files);
    event.target.value = '';
    if (!files.length) return;
    const entries = files.map((file) => ({ file, path: file.webkitRelativePath || file.name }));
    load(entries, entries[0].path.split('/')[0]);
  }

  // ---- Top bar ----

  function updatePlayButton() {
    const button = $('#play');
    const playing = Player.isPlaying;
    button.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    button.replaceChildren(icon(playing ? 'pause' : 'play'));
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
  }

  function updateTime() {
    const { currentTime, duration } = Player.audio;
    const known = Number.isFinite(duration);
    if (known) seekBar.max = duration;
    if (!seekBar.matches(':active')) seekBar.value = currentTime;
    setSliderFill(seekBar);
    $('#time-now').textContent = formatTime(currentTime) || '0:00';
    $('#time-total').textContent = known ? formatTime(duration) : '0:00';
    seekBar.disabled = !known;

    if (known && 'mediaSession' in navigator) {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(currentTime, duration),
        playbackRate: Player.audio.playbackRate || 1,
      });
    }
  }

  function updateNowPlaying(track) {
    $('#now-title').textContent = track.title;
    $('#now-title').disabled = false;
    $('#now-detail').textContent = `${track.artist} · ${track.album}`;
    document.title = `${track.title} – ${track.artist}`;
    for (const id of ['#play', '#prev', '#next']) $(id).disabled = false;
    updateNowHeart();

    const nowArt = $('#now-art');
    nowArt.hidden = true;
    Covers.forTrack(track).then((url) => {
      if (Player.track !== track || !url) return;
      nowArt.src = url;
      nowArt.hidden = false;
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title,
          artist: track.artist,
          album: track.album,
          artwork: [{ src: url }],
        });
      }
    });

    content.querySelectorAll('.row').forEach((row) => {
      const isPlaying = row.dataset.album ? row.dataset.album === track.albumKey : Number(row.dataset.track) === track.id;
      if (isPlaying) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    });

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album,
      });
    }
  }

  // The mini player is the top bar on its own, in a window shrunk to fit it.
  let miniPlayer = false;

  function setMiniPlayer(on) {
    if (on && queueOpen) setQueueOpen(false);
    miniPlayer = on;
    document.documentElement.classList.toggle('mini', on);
    const button = $('#mini-toggle');
    const label = on ? 'Back to the full window' : 'Switch to the mini player';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    button.replaceChildren(icon(on ? 'full' : 'mini'));
    Host.setMini(on);
    // The lists had no height while hidden, so they need drawing again.
    if (!on) {
      setTimeout(() => {
        filterLists.forEach((list) => list.draw(true));
        if (songList) songList.draw(true);
      }, 100);
    }
  }

  function showNowPlayingAlbum() {
    if (!Player.track) return;
    if (miniPlayer) setMiniPlayer(false);
    const playing = shelfFor(Player.track);
    if (playing !== shelf) setShelf(playing);
    searchInput.value = '';
    query = '';
    flipped.clear();
    if (shelf.id === 'audiobooks') {
      heroBook = Player.track.albumKey;
      selectPath([]);
      return;
    }
    if (shelf.id === 'music') openSection = SECTIONS.find((tab) => tab.label === 'Albums');
    revealSelection = true;
    selectPath([{ field: 'album', value: Player.track.albumKey, label: Player.track.album }]);
  }

  // A play counts once over half the song has actually been heard; skipping
  // ahead doesn't add to it.
  const listening = { track: null, heard: 0, lastTime: 0, counted: false };
  let lastPositionSave = 0;

  function startListening(track) {
    listening.track = track;
    listening.heard = 0;
    listening.lastTime = 0;
    listening.counted = false;
  }

  function savePosition(track, seconds) {
    if (track && UserData.remembersPosition(track)) UserData.setPosition(track, seconds);
  }

  function finishedTrack(track) {
    savePosition(track, 0);
    startListening(track);
    if (shelf.id !== 'music') renderMain();
  }

  function trackListening() {
    const { track } = Player;
    if (!track) return;
    if (track !== listening.track) {
      if (listening.lastTime > 0) savePosition(listening.track, listening.lastTime);
      startListening(track);
    }
    const { currentTime, duration } = Player.audio;
    if (Date.now() - lastPositionSave >= POSITION_SAVE_MS) {
      lastPositionSave = Date.now();
      const nearEnd = Number.isFinite(duration) && currentTime > duration - NEAR_END_SECONDS;
      savePosition(track, nearEnd ? 0 : currentTime);
    }
    const step = currentTime - listening.lastTime;
    listening.lastTime = currentTime;
    if (step > 0 && step < 2) listening.heard += step;
    if (!listening.counted && Number.isFinite(duration) && listening.heard >= duration / 2) {
      listening.counted = true;
      UserData.countPlay(track);
      const cell = content.querySelector(`[data-track="${track.id}"] .row-plays`);
      if (cell) cell.textContent = String(UserData.plays(track));
    }
  }

  // Play with nothing loaded starts whatever list is on screen.
  function playOrPause() {
    if (Player.track) Player.toggle();
    else if (visibleTracks.length) startList(visibleTracks, null, { inOrder: shelf.id !== 'music' });
  }

  function setShuffle(on) {
    Player.setShuffle(on);
    const button = $('#shuffle');
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.setAttribute('title', on ? 'Shuffle is on' : 'Shuffle is off');
    try {
      localStorage.setItem('shuffle', on ? '1' : '0');
    } catch {
      // Storage can be blocked; shuffle just won't be remembered.
    }
  }

  function setRepeat(mode) {
    Player.setRepeat(mode);
    const button = $('#repeat');
    button.dataset.mode = mode;
    button.setAttribute('aria-pressed', mode === 'off' ? 'false' : 'true');
    button.setAttribute('title', REPEAT_LABELS[mode]);
    button.setAttribute('aria-label', REPEAT_LABELS[mode]);
    try {
      localStorage.setItem('repeat', mode);
    } catch {
      // Storage can be blocked; repeat just won't be remembered.
    }
  }

  function restoreRepeat() {
    let saved = null;
    try {
      saved = localStorage.getItem('repeat');
    } catch {
      // Storage can be blocked; repeat starts off.
    }
    setRepeat(REPEAT_LABELS[saved] ? saved : 'off');
  }

  function restoreShuffle() {
    let saved = null;
    try {
      saved = localStorage.getItem('shuffle');
    } catch {
      // Storage can be blocked; shuffle starts off.
    }
    setShuffle(saved === '1');
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const handlers = {
      play: () => { if (!Player.isPlaying) playOrPause(); },
      pause: () => { if (Player.isPlaying) Player.toggle(); },
      previoustrack: () => Player.previous(),
      nexttrack: () => Player.next(),
      seekto: (details) => Player.seek(details.seekTime),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Not every browser supports every action.
      }
    }
  }

  function restoreVolume() {
    let saved = null;
    try {
      saved = localStorage.getItem('volume');
    } catch {
      // Storage can be blocked; the default volume is fine.
    }
    const value = saved === null ? NaN : Number(saved);
    if (value >= 0 && value <= 1) volumeBar.value = value;
    Player.setVolume(Number(volumeBar.value));
    setSliderFill(volumeBar);
  }

  // ---- Events ----

  function wireEvents() {
    $('#folder-input').addEventListener('change', onFolderInput);

    let frame = 0;
    scroller.addEventListener('scroll', () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (songList) songList.draw(); });
    });
    window.addEventListener('resize', () => {
      filterLists.forEach((list) => list.draw());
      if (songList) songList.draw();
    });
    phoneLayout.addEventListener('change', render);

    searchInput.addEventListener('input', () => {
      setQuery(searchInput.value.trim());
    });

    $('#play').addEventListener('click', playOrPause);
    $('#shuffle').addEventListener('click', () => {
      setShuffle($('#shuffle').getAttribute('aria-pressed') !== 'true');
    });
    if (Host) {
      const toggle = $('#mini-toggle');
      toggle.hidden = false;
      toggle.setAttribute('aria-label', 'Switch to the mini player');
      toggle.setAttribute('title', 'Switch to the mini player');
      toggle.replaceChildren(icon('mini'));
      toggle.addEventListener('click', () => setMiniPlayer(!miniPlayer));
    }
    // Pressing a button while its menu is open should just close it.
    const opensMenu = (button, open) => {
      let wasOpen = false;
      button.addEventListener('pointerdown', () => { wasOpen = Boolean(openMenu); });
      button.addEventListener('click', () => {
        if (!wasOpen) open();
        wasOpen = false;
      });
    };
    opensMenu($('#shelf-button'), openShelfMenu);
    opensMenu($('#manage-library'), openManageMenu);
    $('#queue-toggle').addEventListener('click', () => setQueueOpen(!queueOpen));
    Player.on('queuechange', renderQueue);
    $('#now-heart').addEventListener('click', () => {
      if (!Player.track) return;
      toggleFavourite(Player.track);
      // The song's row may be on screen behind the mini player's full window.
      if (songList) songList.draw(true);
    });
    $('#repeat').addEventListener('click', () => setRepeat(REPEAT_NEXT[$('#repeat').dataset.mode]));
    $('#prev').addEventListener('click', Player.previous);
    $('#next').addEventListener('click', Player.next);
    $('#now-title').addEventListener('click', showNowPlayingAlbum);

    seekBar.addEventListener('input', () => setSliderFill(seekBar));
    seekBar.addEventListener('change', () => Player.seek(Number(seekBar.value)));

    volumeBar.addEventListener('input', () => {
      Player.setVolume(Number(volumeBar.value));
      setSliderFill(volumeBar);
      try {
        localStorage.setItem('volume', volumeBar.value);
      } catch {
        // Storage can be blocked; volume just won't be remembered.
      }
    });

    window.addEventListener('beforeunload', () => {
      if (Player.track) savePosition(Player.track, Player.audio.currentTime);
      UserData.flush();
    });

    document.addEventListener('pointerdown', (event) => {
      if (openMenu && !openMenu.contains(event.target)) closeMenu();
    });
    window.addEventListener('blur', closeMenu);
    scroller.addEventListener('scroll', closeMenu);

    document.addEventListener('keydown', (event) => {
      if (openMenu) {
        const items = [...openMenu.querySelectorAll('button')];
        const at = items.indexOf(document.activeElement);
        if (event.key === 'Escape') closeMenu();
        if (event.key === 'ArrowDown') items[(at + 1) % items.length].focus();
        if (event.key === 'ArrowUp') items[(at - 1 + items.length) % items.length].focus();
        if (event.key === 'Escape' || event.key.startsWith('Arrow')) event.preventDefault();
        return;
      }
      if (event.target.closest('dialog') || event.target.matches('.rename-input')) return;
      const inSearch = event.target === searchInput;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !inSearch) {
        event.preventDefault();
        selectAllShown();
      } else if (event.key === 'Escape' && !inSearch && selection.size) {
        clearSelection();
        refreshSelection();
      } else if (event.key === 'Escape' && !inSearch && queueOpen && !miniPlayer) {
        setQueueOpen(false);
      } else if (event.key === 'Escape' && inSearch) {
        searchInput.value = '';
        setQuery('');
        searchInput.blur();
      } else if (event.key === '/' && !inSearch) {
        event.preventDefault();
        searchInput.focus();
      } else if (event.key === ' ' && !inSearch) {
        // Keep space working on focused buttons, except rows, which keep focus after a click.
        const onButton = event.target.closest('button');
        if (onButton && !onButton.classList.contains('row')) return;
        event.preventDefault();
        playOrPause();
      }
    });

    Player.on('statechange', updatePlayButton);
    Player.on('time', updateTime);
    Player.on('time', trackListening);
    Player.on('finished', finishedTrack);
    Player.on('statechange', () => {
      if (Player.track && !Player.isPlaying && Player.audio.currentTime > 0) {
        savePosition(Player.track, Player.audio.currentTime);
      }
    });
    Player.setHooks({
      skipsShuffle: UserData.skipsShuffle,
      startPositionFor: (track) => (UserData.remembersPosition(track) ? UserData.position(track) : 0),
      isOffline: () => driveMissing,
      sourceAvailable: async () => {
        if (!Host) return true;
        const folder = await Host.savedFolder();
        if (folder && folder.available) return true;
        setDriveMissing(true);
        return false;
      },
    });
    Player.on('trackchange', updateNowPlaying);
    Player.on('duration', ({ track, seconds }) => {
      if (!track) return;
      Library.setDuration(track, seconds);
      const row = content.querySelector(`[data-track="${track.id}"] .row-time`);
      if (row) row.textContent = formatTime(seconds);
    });
    Player.on('offline', () => showToast(missingMessage()));
    Player.on('unplayable', (track) => showToast(`Skipped “${track.title}”: this browser can't play it.`));
  }

  async function init() {
    document.documentElement.classList.toggle('desktop-app', Boolean(Host));
    await UserData.load();
    restoreShelf();
    wireEvents();
    setupMediaSession();
    restoreVolume();
    restoreShuffle();
    restoreRepeat();
    setSliderFill(seekBar);
    updatePlayButton();

    if (Host) {
      savedFolder = await Host.savedFolder();
      setInterval(checkFolder, DRIVE_CHECK_MS);
      setInterval(checkIpod, DRIVE_CHECK_MS);
      checkIpod();
      if (!savedFolder) render();
      else if (!savedFolder.available) {
        // The saved library can still be browsed until the drive comes back.
        if (await restoreLibrary(savedFolder)) setDriveMissing(true);
        else render();
      } else if (await restoreLibrary(savedFolder)) await refreshLibrary(savedFolder);
      else await openHostFolder(savedFolder);
      return;
    }

    if (SUPPORTS_PICKER) savedFolder = await DB.get('kv', 'folder');
    if (savedFolder && (await savedFolder.queryPermission({ mode: 'read' })) === 'granted') {
      await openHandle(savedFolder);
    } else {
      render();
    }
  }

  init();

  return { load };
})();
