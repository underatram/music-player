// Present only in the desktop app. Makes files on disk look like the browser's
// File objects, so the rest of the player treats them the same way.
const Host = window.musicHost ? (() => {
  const { musicHost } = window;

  function makeFile({ fullPath, name, size, lastModified }) {
    return {
      fullPath,
      name,
      size,
      lastModified,
      mediaUrl: `media://track/${encodeURIComponent(fullPath)}`,
      slice: (start, end = size) => ({
        arrayBuffer: async () => {
          const data = await musicHost.read(fullPath, start, end);
          return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        },
      }),
    };
  }

  async function scan(onFound) {
    musicHost.onScanProgress(onFound);
    const found = await musicHost.scan();
    return found.map((entry) => ({ file: makeFile(entry), path: entry.path }));
  }

  return {
    savedFolder: musicHost.savedFolder,
    pickFolder: musicHost.pickFolder,
    setMini: musicHost.setMini,
    setMiniQueue: musicHost.setMiniQueue,
    readData: musicHost.readData,
    writeData: musicHost.writeData,
    writeDataNow: musicHost.writeDataNow,
    scan,
    makeFile,
  };
})() : null;
