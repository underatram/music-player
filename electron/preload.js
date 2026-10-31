// The only desktop features the page can use.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('musicHost', {
  savedFolder: () => ipcRenderer.invoke('host:saved-folder'),
  pickFolder: () => ipcRenderer.invoke('host:pick-folder'),
  scan: () => ipcRenderer.invoke('host:scan'),
  read: (fullPath, start, end) => ipcRenderer.invoke('host:read', fullPath, start, end),
  ipod: () => ipcRenderer.invoke('host:ipod'),
  ejectIpod: () => ipcRenderer.invoke('host:eject-ipod'),
  mountIpod: () => ipcRenderer.invoke('host:mount-ipod'),
  ipodSongs: () => ipcRenderer.invoke('host:ipod-songs'),
  syncIpod: (request) => ipcRenderer.invoke('host:ipod-sync', request),
  stopIpodSync: () => ipcRenderer.invoke('host:ipod-stop'),
  onIpodProgress: (listener) => {
    ipcRenderer.removeAllListeners('host:ipod-progress');
    ipcRenderer.on('host:ipod-progress', (_event, progress) => listener(progress));
  },
  readTags: (fullPath) => ipcRenderer.invoke('host:read-tags', fullPath),
  writeTags: (fullPath, request) => ipcRenderer.invoke('host:write-tags', fullPath, request),
  pickImage: () => ipcRenderer.invoke('host:pick-image'),
  onWriteProgress: (listener) => {
    ipcRenderer.removeAllListeners('host:write-progress');
    ipcRenderer.on('host:write-progress', (_event, fraction) => listener(fraction));
  },
  setMini: (on) => ipcRenderer.invoke('host:set-mini', on),
  setMiniQueue: (open) => ipcRenderer.invoke('host:set-mini-queue', open),
  readData: () => ipcRenderer.invoke('host:read-data'),
  writeData: (data) => ipcRenderer.invoke('host:write-data', data),
  writeDataNow: (data) => ipcRenderer.sendSync('host:write-data-now', data),
  onScanProgress: (listener) => {
    ipcRenderer.removeAllListeners('host:scan-progress');
    ipcRenderer.on('host:scan-progress', (_event, count) => listener(count));
  },
});
