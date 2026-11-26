/**
 * What the player keeps in the browser between visits: settings, each song's lyric timing, playlists, and where
 * the listener was. All of it is in localStorage, read defensively: anything missing or misshapen falls back to a
 * default instead of breaking the player, and a browser with no storage simply forgets.
 *
 * Only NAS songs are kept here. Songs picked from the device are kept as files elsewhere (library/kept.ts); they
 * can't be in a playlist or a saved session.
 */
import { toPlaylists, toSavedTracks } from '../shared/playlists';
import type { Playlist, PlaylistSync, SavedTrack } from '../shared/playlists';
import type { Repeat } from './queue';

export { toSavedTrack } from '../shared/playlists';
export type { Playlist, SavedTrack } from '../shared/playlists';

/** Where a queue came from. */
export type QueueSource = { kind: 'device' } | { kind: 'folder'; path: string } | { kind: 'playlist'; id: string } | { kind: 'search'; query: string }
  | { kind: 'favourites' } | { kind: 'history' } | { kind: 'queue' };

export interface Settings {
  showRoman: boolean;
  showTranslation: boolean;
  repeat: Repeat;
  shuffle: boolean;
  /**
   * For lyrics timed only by line: sweep across each line over its length, as if it were word-timed, instead of
   * lighting the line whole as it starts. Off unless the listener asks for it.
   */
  sweepLines: boolean;
  /** Whether pressing a lyric line moves the song to it. On unless the listener turns it off. */
  seekOnLine: boolean;
  /** Whether songs are brought to about the same loudness, where their files say how loud they are. On unless turned off. */
  levelVolume: boolean;
  /** Seconds one song fades into the next, 0 to 12; 0 (the default) for none. */
  crossfade: number;
}

/** Where the listener was: the queue, the song open in it and how far in. */
export interface Session {
  /** The NAS the songs are on (its API base). A session is only restored on a device paired with the same one. */
  nas: string;
  source: QueueSource;
  tracks: SavedTrack[];
  /** The open song's NAS id. */
  current: string;
  position: number;
  /** The positions in `tracks` in the order they play, when that isn't the order made afresh from the settings. */
  order?: number[];
}

export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const KEYS = {
  settings: 'taiko:settings',
  offsets: 'taiko:offsets',
  playlists: 'taiko:playlists',
  playlistSync: 'taiko:playlist-sync',
  plays: 'taiko:plays',
  session: 'taiko:session',
} as const;

export const DEFAULT_SETTINGS: Settings = { showRoman: true, showTranslation: true, repeat: 'off', shuffle: false, sweepLines: false, seekOnLine: true, levelVolume: true, crossfade: 0 };

/** The most songs' timings kept; the oldest go first. */
const MAX_OFFSETS = 2000;

function browserStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(key: string, store: Store | null): unknown {
  try {
    const text = store?.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown, store: Store | null): void {
  try {
    store?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is full or switched off: the player works, and forgets.
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function toSource(value: unknown): QueueSource | null {
  if (!isObject(value)) return null;
  if (value.kind === 'folder' && typeof value.path === 'string') return { kind: 'folder', path: value.path };
  if (value.kind === 'playlist' && typeof value.id === 'string') return { kind: 'playlist', id: value.id };
  if (value.kind === 'search' && typeof value.query === 'string') return { kind: 'search', query: value.query };
  if (value.kind === 'favourites' || value.kind === 'history' || value.kind === 'queue') return { kind: value.kind };
  return null;
}

/* ---------- Settings ---------- */

export function loadSettings(store: Store | null = browserStore()): Settings {
  const saved = read(KEYS.settings, store);
  if (!isObject(saved)) return { ...DEFAULT_SETTINGS };
  return {
    showRoman: typeof saved.showRoman === 'boolean' ? saved.showRoman : DEFAULT_SETTINGS.showRoman,
    showTranslation: typeof saved.showTranslation === 'boolean' ? saved.showTranslation : DEFAULT_SETTINGS.showTranslation,
    repeat: saved.repeat === 'all' || saved.repeat === 'one' ? saved.repeat : 'off',
    shuffle: saved.shuffle === true,
    sweepLines: saved.sweepLines === true,
    seekOnLine: typeof saved.seekOnLine === 'boolean' ? saved.seekOnLine : DEFAULT_SETTINGS.seekOnLine,
    levelVolume: typeof saved.levelVolume === 'boolean' ? saved.levelVolume : DEFAULT_SETTINGS.levelVolume,
    crossfade: typeof saved.crossfade === 'number' && saved.crossfade >= 0 && saved.crossfade <= 12 ? Math.round(saved.crossfade) : 0,
  };
}

export function saveSettings(settings: Settings, store: Store | null = browserStore()): void {
  write(KEYS.settings, settings, store);
}

/* ---------- Lyric timing, per song ---------- */

/** How far each song's lyrics were nudged, in seconds, by a key that names the song (see the store). */
export function loadOffsets(store: Store | null = browserStore()): Map<string, number> {
  const saved = read(KEYS.offsets, store);
  const out = new Map<string, number>();
  if (!Array.isArray(saved)) return out;
  for (const entry of saved) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] !== 0) out.set(entry[0], entry[1]);
  }
  return out;
}

/** Remembers a song's nudge (forgets it when it is back to 0), most recent last, dropping the oldest past the limit. */
export function saveOffset(offsets: Map<string, number>, key: string, seconds: number, store: Store | null = browserStore()): void {
  offsets.delete(key);
  if (seconds !== 0) offsets.set(key, seconds);
  while (offsets.size > MAX_OFFSETS) offsets.delete(offsets.keys().next().value as string);
  write(KEYS.offsets, Array.from(offsets), store);
}

/* ---------- Playlists, per NAS ---------- */

export function loadPlaylists(nas: string, store: Store | null = browserStore()): Playlist[] {
  const saved = read(KEYS.playlists, store);
  return toPlaylists(isObject(saved) ? saved[nas] : null);
}

/** What this device remembers about sharing its playlists with a NAS (see `reconcile`). */
export function loadPlaylistSync(nas: string, store: Store | null = browserStore()): PlaylistSync {
  const saved = read(KEYS.playlistSync, store);
  const entry = isObject(saved) ? saved[nas] : null;
  const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  if (!isObject(entry)) return { version: null, dirty: [], deleted: [] };
  return { version: typeof entry.version === 'number' && Number.isFinite(entry.version) ? entry.version : null, dirty: ids(entry.dirty), deleted: ids(entry.deleted) };
}

export function savePlaylistSync(nas: string, sync: PlaylistSync, store: Store | null = browserStore()): void {
  const saved = read(KEYS.playlistSync, store);
  write(KEYS.playlistSync, { ...(isObject(saved) ? saved : {}), [nas]: sync }, store);
}

export function savePlaylists(nas: string, playlists: Playlist[], store: Store | null = browserStore()): void {
  const saved = read(KEYS.playlists, store);
  write(KEYS.playlists, { ...(isObject(saved) ? saved : {}), [nas]: playlists }, store);
}

/* ---------- Plays the NAS hasn't been told of yet, per NAS ---------- */

export interface PendingPlay {
  track: SavedTrack;
  at: string;
}

export function loadPendingPlays(nas: string, store: Store | null = browserStore()): PendingPlay[] {
  const saved = read(KEYS.plays, store);
  const list = isObject(saved) ? saved[nas] : null;
  return (Array.isArray(list) ? list : []).flatMap((entry): PendingPlay[] => {
    const track = isObject(entry) ? toSavedTracks([entry.track])[0] : undefined;
    return track && isObject(entry) && typeof entry.at === 'string' ? [{ track, at: entry.at }] : [];
  });
}

/** Keeps the latest few hundred; older ones that never got through are let go. */
export function savePendingPlays(nas: string, plays: PendingPlay[], store: Store | null = browserStore()): void {
  const saved = read(KEYS.plays, store);
  write(KEYS.plays, { ...(isObject(saved) ? saved : {}), [nas]: plays.slice(-500) }, store);
}

/** A playlist's name as kept: trimmed, with a fallback for an empty one, and not endless. */
export const cleanName = (name: string): string => name.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Untitled playlist';

/** The playlist with `tracks` added at its end, leaving out songs it already has. */
export function withTracks(playlist: Playlist, tracks: SavedTrack[]): Playlist {
  const have = new Set(playlist.tracks.map((track) => track.id));
  const added = tracks.filter((track) => !have.has(track.id) && have.add(track.id));
  return added.length ? { ...playlist, tracks: [...playlist.tracks, ...added] } : playlist;
}

export function withoutTrack(playlist: Playlist, index: number): Playlist {
  if (index < 0 || index >= playlist.tracks.length) return playlist;
  return { ...playlist, tracks: playlist.tracks.filter((_, i) => i !== index) };
}

/** The playlist with the song at `index` moved up (-1) or down (1) one place. */
export function withMoved(playlist: Playlist, index: number, direction: 1 | -1): Playlist {
  const to = index + direction;
  if (index < 0 || index >= playlist.tracks.length || to < 0 || to >= playlist.tracks.length) return playlist;
  const tracks = [...playlist.tracks];
  [tracks[index], tracks[to]] = [tracks[to], tracks[index]];
  return { ...playlist, tracks };
}

/* ---------- Where the listener was ---------- */

export function loadSession(store: Store | null = browserStore()): Session | null {
  const saved = read(KEYS.session, store);
  if (!isObject(saved) || typeof saved.nas !== 'string' || typeof saved.current !== 'string') return null;
  const source = toSource(saved.source);
  const tracks = toSavedTracks(saved.tracks);
  if (!source || !tracks.some((track) => track.id === saved.current)) return null;
  const position = count(saved.position);
  // An order is kept only when it names every song once.
  const order = Array.isArray(saved.order) && saved.order.length === tracks.length && new Set(saved.order).size === tracks.length
    && saved.order.every((index) => Number.isInteger(index) && index >= 0 && index < tracks.length) ? { order: saved.order as number[] } : {};
  return { nas: saved.nas, source, tracks, current: saved.current, position: position !== null && position > 0 ? position : 0, ...order };
}

export function saveSession(session: Session | null, store: Store | null = browserStore()): void {
  if (session) write(KEYS.session, session, store);
  else {
    try {
      store?.removeItem(KEYS.session);
    } catch {
      // Nothing to forget.
    }
  }
}
