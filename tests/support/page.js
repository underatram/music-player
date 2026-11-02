// Loads the page's plain scripts into a sandbox, with stand-ins for the browser.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPage(files, globals = {}) {
  const context = vm.createContext({ console, setTimeout, clearTimeout, TextDecoder, Blob, Uint8Array, Map, Set, ...globals });
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'js', file), 'utf8');
    // Top-level consts stay inside a script, so hand them to the sandbox by name.
    const name = /^const (\w+) = /m.exec(source)[1];
    vm.runInContext(`${source}\nthis.${name} = ${name};`, context, { filename: file });
  }
  return context;
}

// An in-memory stand-in for the page's database, which remembers what was asked for.
function fakeDb() {
  const stores = { tags: new Map(), kv: new Map() };
  return {
    stores,
    get: async (store, key) => stores[store].get(key),
    put: async (store, key, value) => { stores[store].set(key, value); },
  };
}

// A file the page can read, backed by bytes in memory.
function fakeFile(name, bytes, lastModified = 1000, counter = null) {
  return {
    name,
    size: bytes.length,
    lastModified,
    slice: (start, end = bytes.length) => ({
      arrayBuffer: async () => {
        if (counter) counter.reads += 1;
        const part = bytes.subarray(start, end);
        return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength);
      },
    }),
  };
}

module.exports = { loadPage, fakeDb, fakeFile };
