// The desktop app's main process: the window, the chosen music folder, and
// read-only access to the files inside it.
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const AUDIO_EXTENSIONS = /\.(mp3|flac|ogg|oga|opus|m4a|aac|wav)$/i;
const MAX_READ_BYTES = 128 * 1024 * 1024;
const SCAN_PROGRESS_EVERY = 250;
const MIME_TYPES = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
};

app.setPath('userData', path.join(app.getPath('appData'), 'music-player'));
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

let mainWindow = null;
let musicFolder = null;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSavedFolder() {
  try {
    musicFolder = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).folder || null;
  } catch {
    musicFolder = null;
  }
}

function saveFolder(folder) {
  musicFolder = folder;
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify({ folder }));
}

// Favourites, play counts and playlists live in one small file. It's replaced in
// a single step, so a crash can't leave it half written, and the previous
// version is kept alongside it.
const userDataPath = () => path.join(app.getPath('userData'), 'library-data.json');
const userDataBackupPath = () => `${userDataPath()}.backup`;

function readUserData() {
  for (const candidate of [userDataPath(), userDataBackupPath()]) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`Could not read ${candidate}`, err);
        fs.renameSync(candidate, `${candidate}.damaged-${Date.now()}`);
      }
    }
  }
  return null;
}

function writeUserData(data) {
  const target = userDataPath();
  const temporary = `${target}.saving`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(data));
  if (fs.existsSync(target)) fs.copyFileSync(target, userDataBackupPath());
  fs.renameSync(temporary, target);
}

function describeFolder() {
  if (!musicFolder) return null;
  return { path: musicFolder, name: path.basename(musicFolder), available: fs.existsSync(musicFolder) };
}

// The page can only ever reach files inside the folder the person chose.
function assertInsideFolder(fullPath) {
  const resolved = path.resolve(fullPath);
  if (!musicFolder || !resolved.startsWith(musicFolder + path.sep)) {
    throw new Error('Path is outside the music folder');
  }
  return resolved;
}

async function walk(directory, relative, found, onProgress) {
  let entries;
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (err) {
    console.warn(`Could not read ${directory}`, err);
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(directory, entry.name);
    const childPath = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(fullPath, childPath, found, onProgress);
    } else if (entry.isFile() && AUDIO_EXTENSIONS.test(entry.name)) {
      try {
        const stats = await fs.promises.stat(fullPath);
        found.push({ fullPath, path: childPath, name: entry.name, size: stats.size, lastModified: stats.mtimeMs });
        if (found.length % SCAN_PROGRESS_EVERY === 0) onProgress(found.length);
      } catch (err) {
        console.warn(`Could not read ${fullPath}`, err);
      }
    }
  }
}

function setupIpc() {
  ipcMain.handle('host:saved-folder', () => describeFolder());

  ipcMain.handle('host:pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose your music folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    saveFolder(path.resolve(result.filePaths[0]));
    return describeFolder();
  });

  ipcMain.handle('host:scan', async (event) => {
    if (!musicFolder) return [];
    const found = [];
    await walk(musicFolder, path.basename(musicFolder), found, (count) => {
      event.sender.send('host:scan-progress', count);
    });
    return found;
  });

  ipcMain.handle('host:set-mini', (_event, on) => setMiniPlayer(on));
  ipcMain.handle('host:set-mini-queue', (_event, open) => setMiniQueue(open));
  ipcMain.handle('host:read-data', () => readUserData());
  ipcMain.handle('host:write-data', (_event, data) => writeUserData(data));
  ipcMain.on('host:write-data-now', (event, data) => {
    writeUserData(data);
    event.returnValue = true;
  });

  ipcMain.handle('host:read', async (_event, fullPath, start, end) => {
    const length = Math.min(Math.max(0, end - start), MAX_READ_BYTES);
    const handle = await fs.promises.open(assertInsideFolder(fullPath), 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  });
}

// Serves audio files to the page, with the range support that seeking needs.
async function serveMedia(request) {
  let fullPath;
  try {
    fullPath = assertInsideFolder(decodeURIComponent(new URL(request.url).pathname.slice(1)));
  } catch {
    return new Response('Not allowed', { status: 403 });
  }

  let size;
  try {
    ({ size } = await fs.promises.stat(fullPath));
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const headers = {
    'Content-Type': MIME_TYPES[path.extname(fullPath).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);

  const stream = fs.createReadStream(fullPath, { start, end });
  return new Response(Readable.toWeb(stream), { status, headers });
}

const FULL_MINIMUM = { width: 640, height: 560 };
const MINI_SIZE = { width: 640, height: 104 };
const MINI_QUEUE_HEIGHT = 320;
let fullWindow = null; // how the window looked before shrinking to the mini player

function setMiniPlayer(on) {
  if (!mainWindow || on === Boolean(fullWindow)) return;
  if (on) {
    fullWindow = { bounds: mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() };
    if (fullWindow.maximized) mainWindow.unmaximize();
    mainWindow.setMinimumSize(MINI_SIZE.width, MINI_SIZE.height);
    mainWindow.setSize(MINI_SIZE.width, MINI_SIZE.height);
    mainWindow.setResizable(false);
    mainWindow.setMaximizable(false);
    // Some desktops don't let apps float above other windows; there it just won't float.
    mainWindow.setAlwaysOnTop(true);
  } else {
    const { bounds, maximized } = fullWindow;
    fullWindow = null;
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setResizable(true);
    mainWindow.setMaximizable(true);
    mainWindow.setMinimumSize(FULL_MINIMUM.width, FULL_MINIMUM.height);
    mainWindow.setBounds(bounds);
    if (maximized) mainWindow.maximize();
  }
}

// The mini player grows downwards while its Up Next list is open.
function setMiniQueue(open) {
  if (!mainWindow || !fullWindow) return;
  const height = MINI_SIZE.height + (open ? MINI_QUEUE_HEIGHT : 0);
  mainWindow.setResizable(true);
  mainWindow.setMinimumSize(MINI_SIZE.width, height);
  mainWindow.setSize(MINI_SIZE.width, height);
  mainWindow.setResizable(false);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 640,
    minHeight: 560,
    title: 'Music',
    backgroundColor: '#241a20',
    // The purple top bar replaces the system's title bar; these match its colours.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#3a1530', symbolColor: '#f7f2f5', height: 36 },
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    loadSavedFolder();
    setupIpc();
    protocol.handle('media', serveMedia);
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
