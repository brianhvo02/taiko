/**
 * The songs and lyrics picked on this device, kept as copies in the browser's own storage (IndexedDB) so they are
 * still here on the next visit. Nothing leaves the device. Everything here is best effort: a browser without the
 * storage, or without room, leaves the songs for this visit only, as before.
 */

/** A file as it is kept. `owner` is the audio file a lyrics file was given to when its own name didn't say. */
export interface KeptFile {
  file: File;
  owner?: string;
}

interface Row {
  name: string;
  type: string;
  lastModified: number;
  size: number;
  blob: Blob;
  owner?: string;
}

const DB = 'taiko';
const FILES = 'files';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(FILES, { autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('storage'));
    request.onblocked = () => reject(new Error('storage'));
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('storage'));
    transaction.onabort = () => reject(transaction.error ?? new Error('storage'));
  });
}

function all(store: IDBObjectStore): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as Row[]);
    request.onerror = () => reject(request.error ?? new Error('storage'));
  });
}

const same = (row: Row, file: File) => row.name === file.name && row.size === file.size && row.lastModified === file.lastModified;

/** The files kept from earlier visits; none when there are none or the storage can't be read. */
export async function loadKept(): Promise<KeptFile[]> {
  try {
    const db = await open();
    try {
      const rows = await all(db.transaction(FILES).objectStore(FILES));
      return rows.map((row) => ({
        file: new File([row.blob], row.name, { type: row.type, lastModified: row.lastModified }),
        ...(row.owner ? { owner: row.owner } : {}),
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Keeps copies of files, leaving out any that are already kept. Resolves to whether they were all kept: false
 * when the browser has no storage for them or no room.
 */
export async function keepFiles(files: KeptFile[]): Promise<boolean> {
  if (!files.length) return true;
  try {
    const db = await open();
    try {
      const known = await all(db.transaction(FILES).objectStore(FILES));
      const transaction = db.transaction(FILES, 'readwrite');
      const finished = done(transaction);
      for (const { file, owner } of files) {
        if (known.some((row) => same(row, file))) continue;
        const row: Row = { name: file.name, type: file.type, lastModified: file.lastModified, size: file.size, blob: file, ...(owner ? { owner } : {}) };
        transaction.objectStore(FILES).add(row);
      }
      await finished;
      // Asks the browser not to clear the copies when space runs low. It may say no; they are kept all the same.
      void navigator.storage?.persist?.().catch(() => false);
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** Forgets every kept file. */
export async function forgetKept(): Promise<void> {
  try {
    const db = await open();
    try {
      const transaction = db.transaction(FILES, 'readwrite');
      const finished = done(transaction);
      transaction.objectStore(FILES).clear();
      await finished;
    } finally {
      db.close();
    }
  } catch {
    // Nothing was kept, or it can't be reached; either way there is nothing to do.
  }
}
