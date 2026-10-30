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
  const EPISODE_COLUMNS = [
    { label: 'Episode', className: 'column-title', value: (t) => t.title },
    { label: 'Year', value: (t) => t.year },
    { label: 'Time', className: 'column-time', value: (t) => t.duration },
    { label: 'Progress', value: (t) => secondsLeft(t) },
  ];
  const SHOW_COLUMN = { label: 'Show', value: (t) => t.album };

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

  function renderShelves() {
    $('#shelves').replaceChildren(...SHELVES.map((s) => el('button', {
      class: 'shelf',
      role: 'tab',
      'aria-selected': s === shelf ? 'true' : 'false',
      onclick: () => {
        if (s !== shelf) setShelf(s);
      },
    }, s.label)));
    searchInput.placeholder = shelf.search;
    searchInput.setAttribute('aria-label', shelf.search);
  }

  // Each one keeps its own place. A search belongs to the tab it was typed in.
  function setShelf(next) {
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
  function startList(tracks, index = null, options = {}) {
    const waiting = Player.upNext.length;
    Player.playList(tracks, index, options);
    if (!waiting) return;
    const name = path.length ? path[path.length - 1].label : 'this list';
    showToast(`${plural(waiting, 'queued song')} will play first, then ${name}.`);
  }

  // ---- Which songs are showing ----

  function playlistTracks(id) {
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

  // The Podcasts and Audiobooks sidebars: what's under way, then shows or authors.
  function renderListening(row) {
    const listening = matchingPlaylists(shelf.smart.map(({ value, label }) => ({ value, label })));
    const isBooks = shelf.id === 'audiobooks';
    const field = isBooks ? 'artist' : 'album';
    const groups = Library.groups(field, matched, { byName: true });
    const entries = groups.map((group) => ({
      label: group.label,
      path: [{ field, value: group.value, label: group.label }],
      isCurrent: () => path.length > 0 && path[0].field === field && path[0].value === group.value,
    }));
    if (isBooks && !query) {
      entries.unshift({ label: 'All Authors', path: [], isCurrent: () => !path.length });
    }
    return [
      listening.length ? el('h2', { class: 'playlists-heading' }, 'Listening') : null,
      ...listening.map(row),
      entries.length ? el('h2', { class: 'playlists-heading' }, isBooks ? 'Authors' : 'Shows') : null,
      ...entries.map(row),
    ].filter(Boolean);
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
    if (shelf.id === 'audiobooks' || nextField() || !visibleTracks.length) return;
    visibleTracks.forEach((track) => selection.add(track));
    refreshSelection();
  }

  function episodeRow(track, tracks, index, showShow) {
    const progress = episodeProgress(track);
    return el('button', {
      class: `row ${selection.has(track) ? 'row-selected' : ''} ${progress === 'Played' ? 'row-done' : ''}`,
      'data-track': track.id,
      'aria-current': Player.track && Player.track.id === track.id ? 'true' : null,
      onclick: (event) => clickSongRow(event, tracks, index),
      oncontextmenu: (event) => {
        event.preventDefault();
        showSongMenu(event, track);
      },
    },
      el('span', { class: 'row-title' }, track.title),
      el('span', { class: 'row-sub' }, progress || track.album),
      showShow ? el('span', { class: 'row-album' }, track.album) : null,
      el('span', { class: 'row-year' }, track.year ? String(track.year) : ''),
      el('span', { class: 'row-time' }, formatTime(track.duration)),
      el('span', { class: 'row-progress', 'data-left': progress.endsWith('left') ? 'true' : null }, progress));
  }

  function bookRow(book) {
    const progress = bookProgress(book);
    const { groupArtist, albumYear, albumKey } = book.tracks[0];
    return el('button', {
      class: `row ${book.left === 0 ? 'row-done' : ''}`,
      'data-album': albumKey,
      'aria-current': Player.track && Player.track.albumKey === albumKey ? 'true' : null,
      onclick: () => startList(book.tracks, bookStart(book), { inOrder: true }),
      oncontextmenu: (event) => {
        event.preventDefault();
        showGroupMenu(event, book.tracks);
      },
    },
      el('span', { class: 'row-title' }, book.label),
      el('span', { class: 'row-sub' }, progress || groupArtist),
      el('span', { class: 'row-artist' }, groupArtist),
      el('span', { class: 'row-year' }, albumYear ? String(albumYear) : ''),
      el('span', { class: 'row-time' }, book.total ? formatTotal(book.total) : ''),
      el('span', { class: 'row-progress', 'data-left': progress.endsWith('left') ? 'true' : null }, progress));
  }

  function renderBooks() {
    const tracks = baseTracks();
    visibleTracks = tracks;
    const books = booksIn(tracks);
    const authors = Library.groups('artist', tracks);
    const total = books.reduce((sum, book) => sum + book.total, 0);

    let heading = query ? `Results for “${query}”` : 'All Audiobooks';
    if (path.length) heading = path[path.length - 1].label;
    const details = [plural(books.length, 'book')];
    if (authors.length === 1) details.push(authors[0].label);
    else if (authors.length) details.push(plural(authors.length, 'author'));
    if (total) details.push(formatTotal(total));

    const rows = el('div', { class: 'rows' });
    songList = virtualList(scroller, rows, books.length, cssPixels('--row-height'), (i) => bookRow(books[i]));
    const head = el('div', { class: 'list-head book-columns' },
      el('span', { class: 'column column-title' }, 'Book'),
      el('span', { class: 'column' }, 'Author'),
      el('span', { class: 'column' }, 'Year'),
      el('span', { class: 'column column-time' }, 'Length'),
      el('span', { class: 'column' }, 'Progress'));

    const carryOn = books.find((book) => book.left > 0 && book.left < book.total)
      || books.find((book) => book.left > 0)
      || books[0];
    return [
      el('h1', { class: 'heading' }, heading),
      el('p', { class: 'meta' }, details.join(' · ')),
      books.length ? el('div', { class: 'page-links' }, el('button', {
        class: 'page-link',
        onclick: () => startList(carryOn.tracks, bookStart(carryOn), { inOrder: true }),
      }, icon('play'), 'Carry On Listening')) : null,
      books.length ? head : el('p', { class: 'empty' }, emptyMessage()),
      books.length ? el('div', { class: 'rows-wrap book-columns' }, rows) : null,
    ].filter(Boolean);
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
    if (shelf.id === 'podcasts') {
      const isShow = path.length > 0 && path[0].field === 'album';
      return el('div', { class: 'page-links' },
        el('button', {
          class: 'page-link',
          onclick: () => {
            // A show's newest episode is the last in its own order, however it's sorted.
            const list = isShow ? baseTracks() : visibleTracks;
            startList(list, isShow ? list.length - 1 : 0, { inOrder: true });
          },
        }, icon('play'), isShow ? 'Play Latest' : 'Play'),
        el('span', { class: 'selection-count' }, selection.size ? `${selection.size.toLocaleString()} selected` : ''));
    }
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
    const isPodcasts = shelf.id === 'podcasts';
    const songWord = isPodcasts ? 'episode' : 'song';
    const count = plural(tracks.length, query && !path.length ? 'result' : songWord);
    visibleTracks = tracks;

    let heading = query ? `Results for “${query}”` : 'All Songs';
    const details = [];
    if (path.length) {
      heading = path[path.length - 1].label;
      if (path[path.length - 1].field === 'album' && tracks.length) {
        const { groupArtist, albumYear } = tracks[0];
        if (!path.some((step) => step.field === 'artist')) details.push(groupArtist);
        if (albumYear && !isPodcasts && !path.some((step) => step.field === 'year')) details.push(String(albumYear));
      }
    }
    details.push(count);
    if (total) details.push(formatTotal(total));

    const isShow = isPodcasts && path.length > 0 && path[0].field === 'album';
    const isAlbumPage = !isPodcasts && path.length > 0 && path[path.length - 1].field === 'album' && tracks.length > 0;
    showLastPlayed = isAlbumPage;
    const rowHeight = cssPixels('--row-height');
    const rows = el('div', { class: 'rows' });
    const canReorder = inPlaylist() && UserData.findPlaylist(path[0].value) && !query && !sortColumn;
    const reorder = canReorder ? playlistReorder(tracks, rows, rowHeight) : null;
    songList = virtualList(scroller, rows, tracks.length, rowHeight, (i) => (isPodcasts
      ? episodeRow(tracks[i], tracks, i, !isShow)
      : songRow(tracks[i], tracks, i, reorder)));

    let columns = COLUMNS;
    let columnClass = isAlbumPage ? 'with-last-played' : '';
    if (isRecentlyPlayed()) columns = COLUMNS.map((column) => (column.label === 'Genre' ? LAST_PLAYED_COLUMN : column));
    if (isAlbumPage) columns = [...COLUMNS, LAST_PLAYED_COLUMN];
    if (isPodcasts) {
      columns = isShow ? EPISODE_COLUMNS : [EPISODE_COLUMNS[0], SHOW_COLUMN, ...EPISODE_COLUMNS.slice(1)];
      columnClass = isShow ? 'episode-columns' : 'episode-columns-with-show';
    }
    const head = el('div', { class: `list-head ${columnClass}` }, ...columns.map((column) => {
      const active = sortColumn === column;
      return el('button', {
        class: `column ${column.className || ''}`,
        'aria-label': `Sort by ${column.label}`,
        'aria-pressed': active ? 'true' : 'false',
        onclick: () => sortBy(column),
      }, active ? `${column.label} ${sortDescending ? '▼' : '▲'}` : column.label);
    }), isPodcasts ? null : el('span', { class: 'column column-extra' }));

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
  }

  // items: { label, action, checked?, accent? }, { heading } or 'line'.
  function showMenu(event, items) {
    closeMenu();
    const menu = el('div', { class: 'menu', role: 'menu' }, ...items.map((item) => {
      if (item === 'line') return el('div', { class: 'menu-line' });
      if (item.heading) return el('div', { class: 'menu-heading' }, item.heading);
      const isToggle = item.checked !== undefined;
      return el('button', {
        class: `menu-item ${item.accent ? 'menu-item-accent' : ''}`,
        role: isToggle ? 'menuitemcheckbox' : 'menuitem',
        'aria-checked': isToggle ? String(item.checked) : null,
        onclick: () => {
          closeMenu();
          item.action();
        },
      },
        el('span', { class: 'menu-mark' }, item.accent ? icon('plus') : (item.checked ? '✓' : '')),
        el('span', { class: 'menu-label' }, item.label));
    }));
    document.body.append(menu);
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 8)}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
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
    showMenu(event, [{ label: 'Play Next', action: () => playNext(tracks) }, 'line', ...addToPlaylistItems(tracks)]);
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

  function renderMain() {
    songList = null;
    visibleTracks = [];
    if (Library.tracks.length) {
      const field = shelf.id === 'audiobooks' ? null : nextField();
      if (shelf.id === 'audiobooks') content.replaceChildren(...renderBooks());
      else content.replaceChildren(...(field ? renderGroups(field) : renderSongs()));
      songList.draw(true);
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
    // Podcasts has no page for everything at once, so it opens on the first show.
    if (shelf.id === 'podcasts' && !query && !path.length && inShelf.length) {
      const [first] = Library.groups('album', inShelf, { byName: true });
      path = [{ field: 'album', value: first.value, label: first.label }];
    }
    renderShelves();
    renderSide();
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
    $('#change-folder').hidden = false;
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
    $('#change-folder').hidden = false;
    render();
    return true;
  }

  // Checks the folder behind the scenes and only touches the library if songs changed.
  async function refreshLibrary(folder) {
    const status = $('#scan-status');
    const summary = `${plural(Library.tracks.length, 'song')} in ${folder.name}`;
    status.textContent = `${summary} · checking for changes…`;

    const entries = await Host.scan(() => {});
    const current = await Host.savedFolder();
    if (!current || current.path !== folder.path) return;
    if (!current.available) {
      status.textContent = summary;
      return;
    }

    const known = new Map(Library.tracks.map((t) => [t.path, t.file]));
    const unchanged = entries.length === known.size && entries.every(({ path, file }) => {
      const previous = known.get(path);
      return previous && previous.size === file.size && previous.lastModified === file.lastModified;
    });
    if (unchanged) {
      status.textContent = summary;
      return;
    }

    const result = await Library.ingest(entries, (stats) => {
      status.textContent = `Updating library: ${stats.done.toLocaleString()} of ${stats.total.toLocaleString()}`;
    }, { keepCurrent: true });
    if (result.cancelled) return;

    status.textContent = `${plural(result.total, 'song')} in ${folder.name}`;
    if (!inPlaylist() && !Library.within(path).length) path = [];
    render();
    await saveLibrary(folder);
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
    if (shelf.id !== 'music' && songList) renderMain();
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
    $('#change-folder').addEventListener('click', pickFolder);
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
    });
    Player.on('trackchange', updateNowPlaying);
    Player.on('duration', ({ track, seconds }) => {
      if (!track) return;
      Library.setDuration(track, seconds);
      const row = content.querySelector(`[data-track="${track.id}"] .row-time`);
      if (row) row.textContent = formatTime(seconds);
    });
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
      if (!savedFolder || !savedFolder.available) render();
      else if (await restoreLibrary(savedFolder)) await refreshLibrary(savedFolder);
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
