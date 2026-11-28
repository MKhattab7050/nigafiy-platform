// Keeps the transfer queue in IndexedDB so a closed or reloaded page can continue it: uploads and
// device-to-device copies continue where they stopped (the agent keeps its side), downloads to a
// folder on this computer start that file again. Records hold paths, sizes, the checksum state and
// the File System Access handles the operator picked; never file contents. One store per signed-in
// user of this browser.

const DB = 'nigafiy-transfers';
const STORE = 'jobs';

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('owner', 'owner');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
const db = () => (dbPromise ??= open());

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise<T | undefined>((resolve) => {
        if (!d) return resolve(undefined);
        try {
          const tx = d.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req ? (req.result as T) : undefined);
          tx.onerror = () => resolve(undefined);
          tx.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

export interface StoredRecord {
  id: string;
  owner: string;
  [k: string]: unknown;
}

export const transferStore = {
  async put(rec: StoredRecord) {
    try {
      await run('readwrite', (s) => s.put(rec));
    } catch {
      /* a record that cannot be cloned is simply not kept */
    }
  },
  async remove(id: string) {
    await run('readwrite', (s) => s.delete(id));
  },
  async load(owner: string): Promise<StoredRecord[]> {
    const all = await run<StoredRecord[]>('readonly', (s) => s.index('owner').getAll(owner));
    return all ?? [];
  },
};
