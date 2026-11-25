/**
 * The playlists every paired device shares, in `DATA_DIR/playlists.json`. One set per server: the server has
 * devices, not accounts. The file is read on every request and replaced whole on every change, like the pairing
 * store. Each change raises `version`; a device says which version its change was made from, and is refused when
 * another device changed the playlists in between, so that it can look again and bring the two together.
 */
import path from 'node:path';
import { toPlaylists } from '../../src/shared/playlists';
import type { Playlist } from '../../src/shared/playlists';
import { readJsonFile, writeJsonAtomic } from './store';

export interface PlaylistData {
  version: number;
  playlists: Playlist[];
}

export class PlaylistStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'playlists.json');
  }

  read(): PlaylistData {
    const raw = readJsonFile(this.file) as Partial<PlaylistData> | undefined;
    const version = typeof raw?.version === 'number' && Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : 0;
    return { version, playlists: toPlaylists(raw?.playlists) };
  }

  /** Replaces the playlists when they are still at version `base`. Null when another change got there first. */
  replace(base: number, playlists: Playlist[]): PlaylistData | null {
    const current = this.read();
    if (current.version !== base) return null;
    const next = { version: current.version + 1, playlists };
    writeJsonAtomic(this.file, next);
    return next;
  }
}
