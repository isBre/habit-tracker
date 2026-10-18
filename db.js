// Storage layer: tutto ciò che tocca il database passa da qui.
// IndexedDB locale sul telefono. Per passare a un backend basta reimplementare questi metodi.

const DB_NAME = 'habit-tracker';
const DB_VERSION = 1;

let dbPromise;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('habits')) d.createObjectStore('habits', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('days')) d.createObjectStore('days', { keyPath: 'date' });
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return openDB().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  all: store => tx(store, 'readonly', s => s.getAll()),
  put: (store, obj) => tx(store, 'readwrite', s => { s.put(obj); }),
  putMany: (store, arr) => tx(store, 'readwrite', s => { arr.forEach(o => s.put(o)); }),
  del: (store, id) => tx(store, 'readwrite', s => { s.delete(id); }),
  clear: store => tx(store, 'readwrite', s => { s.clear(); }),
  getSetting: async key => (await tx('settings', 'readonly', s => s.get(key)))?.value,
  setSetting: (key, value) => tx('settings', 'readwrite', s => { s.put({ key, value }); }),
};
