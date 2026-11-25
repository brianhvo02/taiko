/**
 * NAS songs kept on this device, to play with no connection: each song's audio and lyrics as a copy in the
 * browser's own storage (IndexedDB, beside the songs picked from the device), and the albums and playlists the
 * listener asked to keep. A song is stored once however many albums and playlists hold it, and goes when the last
 * of them does. Everything is best effort: a browser without the storage keeps nothing.
 */
import type { SavedTrack } from '../shared/playlists';
import { OFFLINE_SETS, OFFLINE_TRACKS, openDb } from './kept';

/** One song's copy. */
export interface OfflineTrack {
  /** The NAS track id. */
  id: string;
  /** The audio file's name, so its format is known. */
  name: string;
  blob: Blob;
  lyrics: { name: string; text: string }[];
  bytes: number;
}

/** An album or a playlist kept on this device, with its songs as they were when it was kept. */
export interface OfflineSet {
  /** `album:<folder path>` or `playlist:<id>`. */
  key: string;
  kind: 'album' | 'playlist';
  title: string;
  /** An album's artist; empty for a playlist. */
  detail: string;
  tracks: SavedTrack[];
  bytes: number;
  cover: Blob | null;
  keptAt: string;
}

function wait<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('storage'));
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('storage'));
    transaction.onabort = () => reject(transaction.error ?? new Error('storage'));
  });
}

async function withDb<T>(work: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await work(db);
  } finally {
    db.close();
  }
}

/** What is kept: the albums and playlists, and the ids of every song stored. Nothing when the storage can't be read. */
export async function loadOffline(): Promise<{ sets: OfflineSet[]; ids: string[] }> {
  try {
    return await withDb(async (db) => {
      const transaction = db.transaction([OFFLINE_SETS, OFFLINE_TRACKS]);
      const sets = await wait(transaction.objectStore(OFFLINE_SETS).getAll() as IDBRequest<OfflineSet[]>);
      const ids = await wait(transaction.objectStore(OFFLINE_TRACKS).getAllKeys());
      return { sets: sets.sort((a, b) => b.keptAt.localeCompare(a.keptAt)), ids: ids.map(String) };
    });
  } catch {
    return { sets: [], ids: [] };
  }
}

/** A kept song's copy, or null. */
export async function offlineTrack(id: string): Promise<OfflineTrack | null> {
  try {
    return (await withDb((db) => wait(db.transaction(OFFLINE_TRACKS).objectStore(OFFLINE_TRACKS).get(id) as IDBRequest<OfflineTrack | undefined>))) ?? null;
  } catch {
    return null;
  }
}

/** Stores a song's copy. Throws when the browser has no room or no storage. */
export async function keepTrack(track: OfflineTrack): Promise<void> {
  await withDb(async (db) => {
    const transaction = db.transaction(OFFLINE_TRACKS, 'readwrite');
    const finished = done(transaction);
    transaction.objectStore(OFFLINE_TRACKS).put(track);
    await finished;
  });
  // Asks the browser not to clear the copies when space runs low. It may say no; they are kept all the same.
  void navigator.storage?.persist?.().catch(() => false);
}

export async function keepSet(set: OfflineSet): Promise<void> {
  await withDb(async (db) => {
    const transaction = db.transaction(OFFLINE_SETS, 'readwrite');
    const finished = done(transaction);
    transaction.objectStore(OFFLINE_SETS).put(set);
    await finished;
  });
}

/** Forgets an album or a playlist, and the copies of its songs that nothing else kept still holds. */
export async function removeSet(key: string): Promise<void> {
  await withDb(async (db) => {
    const transaction = db.transaction([OFFLINE_SETS, OFFLINE_TRACKS], 'readwrite');
    const finished = done(transaction);
    const sets = await wait(transaction.objectStore(OFFLINE_SETS).getAll() as IDBRequest<OfflineSet[]>);
    const gone = sets.find((set) => set.key === key);
    const held = new Set(sets.filter((set) => set.key !== key).flatMap((set) => set.tracks.map((track) => track.id)));
    transaction.objectStore(OFFLINE_SETS).delete(key);
    for (const track of gone?.tracks ?? []) if (!held.has(track.id)) transaction.objectStore(OFFLINE_TRACKS).delete(track.id);
    await finished;
  });
}

/** Removes stored songs that no kept album or playlist holds: what a stopped or failed keeping left behind. */
export async function removeStrays(): Promise<void> {
  try {
    await withDb(async (db) => {
      const transaction = db.transaction([OFFLINE_SETS, OFFLINE_TRACKS], 'readwrite');
      const finished = done(transaction);
      const sets = await wait(transaction.objectStore(OFFLINE_SETS).getAll() as IDBRequest<OfflineSet[]>);
      const held = new Set(sets.flatMap((set) => set.tracks.map((track) => track.id)));
      for (const id of await wait(transaction.objectStore(OFFLINE_TRACKS).getAllKeys())) if (!held.has(String(id))) transaction.objectStore(OFFLINE_TRACKS).delete(id);
      await finished;
    });
  } catch {
    // Nothing to tidy, or it can't be reached.
  }
}

/** How much this browser is storing for the site, and about how much it may: null where the browser won't say. */
export async function storageUse(): Promise<{ used: number; quota: number } | null> {
  try {
    const estimate = await navigator.storage.estimate();
    return typeof estimate.usage === 'number' && typeof estimate.quota === 'number' ? { used: estimate.usage, quota: estimate.quota } : null;
  } catch {
    return null;
  }
}
