/**
 * Every user's playlists, in `DATA_DIR/playlists.json`. Each user has their own set with its own `version`; a set
 * is replaced whole by its owner's devices, which say which version their change was made from and are refused
 * when the set changed in between, so they can look again and bring the two together.
 *
 * A playlist is private unless its owner says otherwise: `public` lets the other users see and play it, and
 * `collaborative` lets them change its songs too. A collaborator's change raises the owner's version, so the
 * owner's devices take it up like any other change.
 *
 * The file is read on every request and written whole, like the pairing store. A file from before there were users
 * holds one set, which becomes the owner's.
 */
import path from 'node:path';
import { toPlaylists } from '../../src/shared/playlists';
import type { Playlist, SavedTrack } from '../../src/shared/playlists';
import { OWNER_ID } from './auth';
import { readJsonFile, writeJsonAtomic } from './store';

export interface PlaylistData {
  version: number;
  playlists: Playlist[];
}

interface PlaylistFile {
  format: 2;
  users: Record<string, PlaylistData>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function toData(raw: unknown): PlaylistData {
  const data = isObject(raw) ? raw : {};
  const version = typeof data.version === 'number' && Number.isSafeInteger(data.version) && data.version > 0 ? data.version : 0;
  return { version, playlists: toPlaylists(data.playlists) };
}

export class PlaylistStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'playlists.json');
  }

  private read(): PlaylistFile {
    const raw = readJsonFile(this.file);
    const users: Record<string, PlaylistData> = {};
    if (isObject(raw) && isObject(raw.users)) {
      for (const [id, data] of Object.entries(raw.users)) users[id] = toData(data);
    } else if (isObject(raw)) {
      // From before there were users: one set, shared by every device. It is the owner's now.
      users[OWNER_ID] = toData(raw);
    }
    return { format: 2, users };
  }

  /** A user's own playlists. */
  of(userId: string): PlaylistData {
    return this.read().users[userId] ?? { version: 0, playlists: [] };
  }

  /** Replaces a user's playlists when they are still at version `base`. Null when another change got there first. */
  replace(userId: string, base: number, playlists: Playlist[]): PlaylistData | null {
    const file = this.read();
    const current = file.users[userId] ?? { version: 0, playlists: [] };
    if (current.version !== base) return null;
    file.users[userId] = { version: current.version + 1, playlists };
    writeJsonAtomic(this.file, file);
    return file.users[userId];
  }

  /** The playlists other users let `userId` see, each with whose it is. */
  sharedWith(userId: string): { ownerId: string; playlist: Playlist }[] {
    return Object.entries(this.read().users)
      .filter(([ownerId]) => ownerId !== userId)
      .flatMap(([ownerId, data]) => data.playlists.filter((playlist) => playlist.access === 'public' || playlist.access === 'collaborative').map((playlist) => ({ ownerId, playlist })));
  }

  /**
   * Replaces the songs of someone's collaborative playlist. 'missing' when there is no such playlist to be seen,
   * 'closed' when it is only public.
   */
  replaceTracks(ownerId: string, playlistId: string, tracks: SavedTrack[]): Playlist | 'missing' | 'closed' {
    const file = this.read();
    const data = file.users[ownerId];
    const playlist = data?.playlists.find((candidate) => candidate.id === playlistId);
    if (!data || !playlist || !playlist.access || playlist.access === 'private') return 'missing';
    if (playlist.access !== 'collaborative') return 'closed';
    const changed = { ...playlist, tracks };
    file.users[ownerId] = { version: data.version + 1, playlists: data.playlists.map((candidate) => (candidate === playlist ? changed : candidate)) };
    writeJsonAtomic(this.file, file);
    return changed;
  }

  /** A user is gone: the playlists they shared pass to the owner, the private ones go. How many passed on. */
  removeUser(userId: string): number {
    const file = this.read();
    const data = file.users[userId];
    if (!data || userId === OWNER_ID) return 0;
    const kept = data.playlists.filter((playlist) => playlist.access === 'public' || playlist.access === 'collaborative');
    delete file.users[userId];
    if (kept.length) {
      const owner = file.users[OWNER_ID] ?? { version: 0, playlists: [] };
      const taken = new Set(owner.playlists.map((playlist) => playlist.id));
      file.users[OWNER_ID] = { version: owner.version + 1, playlists: [...owner.playlists, ...kept.filter((playlist) => !taken.has(playlist.id))] };
    }
    writeJsonAtomic(this.file, file);
    return kept.length;
  }
}
