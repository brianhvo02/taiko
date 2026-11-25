/**
 * Playlists as they are stored (in the browser, and on the NAS for every paired device to share), and how a
 * device's copy and the NAS's copy are brought together. Used by the player and the server, so it touches neither
 * the DOM nor Node.
 */
import type { NasTrack } from './api';

/** A NAS song as it is stored: what the folder browser said about it, without its lyrics list or cover address. */
export type SavedTrack = Omit<NasTrack, 'lyrics'>;

/**
 * Who but its owner may use a playlist: nobody (`private`, also what a missing value means), every user of the NAS
 * to see and play (`public`), or every user to change its songs as well (`collaborative`).
 */
export type PlaylistAccess = 'private' | 'public' | 'collaborative';

export interface Playlist {
  id: string;
  name: string;
  tracks: SavedTrack[];
  access?: PlaylistAccess;
}

/** Someone else's playlist, as the NAS shows it to a user who may see it. */
export interface SharedPlaylist extends Playlist {
  access: 'public' | 'collaborative';
  owner: { id: string; name: string };
}

/** The most the NAS keeps: playlists, songs in one, and characters in a name or an id. */
export const MAX_PLAYLISTS = 500;
export const MAX_PLAYLIST_TRACKS = 5000;
export const MAX_PLAYLIST_NAME = 80;
const MAX_ID = 2000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** A stored song, or null when what was stored isn't one. */
export function toSavedTrack(value: unknown): SavedTrack | null {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id || typeof value.title !== 'string') return null;
  const track: SavedTrack = {
    id: value.id,
    title: value.title,
    artist: text(value.artist),
    album: text(value.album),
    trackNumber: count(value.trackNumber),
    discNumber: count(value.discNumber),
    durationSeconds: count(value.durationSeconds),
  };
  for (const key of ['titleRoman', 'artistRoman', 'albumRoman', 'titleEnglish', 'artistEnglish', 'albumEnglish', 'appleSongId', 'albumArtist', 'albumArtistRoman', 'date'] as const) {
    if (typeof value[key] === 'string' && value[key]) track[key] = value[key] as string;
  }
  return track;
}

export const toSavedTracks = (value: unknown): SavedTrack[] =>
  (Array.isArray(value) ? value : []).map(toSavedTrack).filter((track): track is SavedTrack => track !== null);

/** Stored playlists, leaving out anything that isn't one. */
export function toPlaylists(value: unknown): Playlist[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Playlist[] => {
    if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id || typeof entry.name !== 'string') return [];
    const access: { access?: PlaylistAccess } = entry.access === 'public' || entry.access === 'collaborative' ? { access: entry.access } : {};
    return [{ id: entry.id, name: entry.name, tracks: toSavedTracks(entry.tracks), ...access }];
  });
}

/**
 * Playlists a device sent, as the NAS will keep them, or null when they are more or longer than it keeps. Unknown
 * fields are dropped, so nothing but playlists is ever stored.
 */
export function acceptPlaylists(value: unknown): Playlist[] | null {
  if (!Array.isArray(value) || value.length > MAX_PLAYLISTS) return null;
  const playlists = toPlaylists(value);
  if (playlists.length !== value.length || new Set(playlists.map((playlist) => playlist.id)).size !== playlists.length) return null;
  const long = (s: string | undefined, max: number) => (s?.length ?? 0) > max;
  for (const playlist of playlists) {
    if (long(playlist.id, MAX_ID) || long(playlist.name, MAX_PLAYLIST_NAME) || playlist.tracks.length > MAX_PLAYLIST_TRACKS) return null;
    if (playlist.tracks.some((track) => Object.values(track).some((field) => typeof field === 'string' && field.length > MAX_ID))) return null;
  }
  return playlists;
}

/** Songs a collaborator sent for someone's playlist, as the NAS will keep them, or null when they are too many or too long. */
export function acceptTracks(value: unknown): SavedTrack[] | null {
  if (!Array.isArray(value) || value.length > MAX_PLAYLIST_TRACKS) return null;
  const tracks = toSavedTracks(value);
  if (tracks.length !== value.length) return null;
  if (tracks.some((track) => Object.values(track).some((field) => typeof field === 'string' && field.length > MAX_ID))) return null;
  return tracks;
}

/** What a device remembers about sharing its playlists with a NAS. */
export interface PlaylistSync {
  /** The version of the NAS's playlists this device last agreed with; null before the first time. */
  version: number | null;
  /** Playlists made or changed here since then, and playlists deleted here since then, by id. */
  dirty: string[];
  deleted: string[];
}

export const NEVER_SYNCED: PlaylistSync = { version: null, dirty: [], deleted: [] };

/**
 * Brings a device's playlists and the NAS's together. The NAS's are the base. A playlist changed here since the
 * last agreement replaces the NAS's copy whole (the last change wins; two devices' changes to one playlist aren't
 * mixed), one made here is added, and one deleted here is left out. The first time, every playlist on the device
 * that the NAS doesn't have is added, so nothing made before sharing began is lost. `push` says whether the
 * result differs from the NAS's and should be sent to it.
 */
export function reconcile(local: Playlist[], remote: Playlist[], sync: PlaylistSync): { playlists: Playlist[]; push: boolean } {
  const mine = new Map(local.map((playlist) => [playlist.id, playlist]));
  const theirs = new Set(remote.map((playlist) => playlist.id));
  const first = sync.version === null;
  const dirty = new Set(sync.dirty);
  const deleted = new Set(sync.deleted);
  let push = false;
  const playlists: Playlist[] = [];
  for (const playlist of remote) {
    if (deleted.has(playlist.id)) { push = true; continue; }
    const changed = dirty.has(playlist.id) ? mine.get(playlist.id) : undefined;
    if (changed) push = true;
    playlists.push(changed ?? playlist);
  }
  for (const playlist of local) {
    if (theirs.has(playlist.id) || !(first || dirty.has(playlist.id))) continue;
    playlists.push(playlist);
    push = true;
  }
  return { playlists, push };
}

/** What changed between two lists of playlists on a device, added to what it already had to tell the NAS. */
export function noteChanges(before: Playlist[], after: Playlist[], sync: PlaylistSync): PlaylistSync {
  const was = new Map(before.map((playlist) => [playlist.id, playlist]));
  const now = new Set(after.map((playlist) => playlist.id));
  const dirty = new Set(sync.dirty);
  const deleted = new Set(sync.deleted);
  for (const playlist of after) {
    if (was.get(playlist.id) !== playlist) dirty.add(playlist.id);
    deleted.delete(playlist.id);
  }
  for (const id of was.keys()) {
    if (!now.has(id)) { deleted.add(id); dirty.delete(id); }
  }
  return { version: sync.version, dirty: [...dirty], deleted: [...deleted] };
}
