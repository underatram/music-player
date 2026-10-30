// The only desktop features the page can use.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('musicHost', {
  savedFolder: () => ipcRenderer.invoke('host:saved-folder'),
  pickFolder: () => ipcRenderer.invoke('host:pick-folder'),
  scan: () => ipcRenderer.invoke('host:scan'),
  read: (fullPath, start, end) => ipcRenderer.invoke('host:read', fullPath, start, end),
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
