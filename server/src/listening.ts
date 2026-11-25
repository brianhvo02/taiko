/**
 * What each user has marked and heard: favourites in `DATA_DIR/favourites.json`, and a line for every song played
 * in `DATA_DIR/history/<user id>.jsonl`. Both belong to one user and are shown to nobody else.
 *
 * Favourites are read and written whole, like the other small stores. History is only ever added to, one line a
 * play, and read back into counts and lists; a user's file is parsed again only when it has changed.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FavouriteAlbum, FavouriteSong, HistoryResponse, Play } from '../../src/shared/api';
import { toSavedTrack } from '../../src/shared/playlists';
import type { SavedTrack } from '../../src/shared/playlists';
import { readJsonFile, writeJsonAtomic } from './store';

export const MAX_FAVOURITES = 20_000;
/** How much of the history `GET history` sends: the latest plays, the songs played most, the albums played lately. */
export const HISTORY_PLAYS = 200;
export const HISTORY_TOP = 50;
export const HISTORY_ALBUMS = 12;

interface Favourites {
  songs: FavouriteSong[];
  albums: FavouriteAlbum[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function toFavourites(raw: unknown): Favourites {
  const data = isObject(raw) ? raw : {};
  const songs = (Array.isArray(data.songs) ? data.songs : []).flatMap((entry): FavouriteSong[] => {
    const track = toSavedTrack(isObject(entry) ? entry.track : null);
    return track && isObject(entry) ? [{ track, addedAt: text(entry.addedAt) }] : [];
  });
  const albums = (Array.isArray(data.albums) ? data.albums : []).flatMap((entry): FavouriteAlbum[] =>
    (isObject(entry) && typeof entry.path === 'string' && entry.path ? [{ path: entry.path, title: text(entry.title), artist: text(entry.artist), addedAt: text(entry.addedAt) }] : []));
  return { songs, albums };
}

/** The folder a track id's file is in (`Root/Artist/Album`), or '' when the id isn't a path. */
function folderOfId(id: string): string {
  try {
    const file = Buffer.from(id, 'base64url').toString('utf8');
    const cut = file.lastIndexOf('/');
    return cut > 0 ? file.slice(0, cut) : '';
  } catch {
    return '';
  }
}

interface Parsed {
  mtimeMs: number;
  size: number;
  plays: Play[];
}

export class ListeningStore {
  private readonly favouritesFile: string;
  private readonly historyDir: string;
  private readonly parsed = new Map<string, Parsed>();

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.favouritesFile = path.join(dataDir, 'favourites.json');
    this.historyDir = path.join(dataDir, 'history');
  }

  private readFavourites(): Record<string, Favourites> {
    const raw = readJsonFile(this.favouritesFile);
    const users = isObject(raw) && isObject(raw.users) ? raw.users : {};
    return Object.fromEntries(Object.entries(users).map(([id, data]) => [id, toFavourites(data)]));
  }

  favourites(userId: string): Favourites {
    return this.readFavourites()[userId] ?? { songs: [], albums: [] };
  }

  private change(userId: string, change: (mine: Favourites) => Favourites | null): boolean {
    const users = this.readFavourites();
    const next = change(users[userId] ?? { songs: [], albums: [] });
    if (!next) return false;
    users[userId] = next;
    writeJsonAtomic(this.favouritesFile, { users });
    return true;
  }

  /** Marks or unmarks a song. Marking one already marked refreshes what is known about it and keeps its place. */
  setSong(userId: string, track: SavedTrack, on: boolean): boolean {
    return this.change(userId, (mine) => {
      const had = mine.songs.find((song) => song.track.id === track.id);
      if (!on) return had ? { ...mine, songs: mine.songs.filter((song) => song !== had) } : mine;
      if (had) return { ...mine, songs: mine.songs.map((song) => (song === had ? { ...song, track } : song)) };
      if (mine.songs.length >= MAX_FAVOURITES) return null;
      return { ...mine, songs: [...mine.songs, { track, addedAt: new Date(this.now()).toISOString() }] };
    });
  }

  setAlbum(userId: string, album: { path: string; title: string; artist: string }, on: boolean): boolean {
    return this.change(userId, (mine) => {
      const had = mine.albums.find((entry) => entry.path === album.path);
      if (!on) return had ? { ...mine, albums: mine.albums.filter((entry) => entry !== had) } : mine;
      if (had) return { ...mine, albums: mine.albums.map((entry) => (entry === had ? { ...entry, ...album } : entry)) };
      if (mine.albums.length >= MAX_FAVOURITES) return null;
      return { ...mine, albums: [...mine.albums, { ...album, addedAt: new Date(this.now()).toISOString() }] };
    });
  }

  private historyFile(userId: string): string {
    // A user's id is made by the server (hex, or "owner"); anything else names no file.
    return path.join(this.historyDir, `${/^[a-z0-9]+$/.test(userId) ? userId : '_'}.jsonl`);
  }

  /** Notes that a user played a song, at `at` when the device says when (a play it couldn't report at the time). */
  addPlay(userId: string, track: SavedTrack, at?: string): void {
    const now = this.now();
    const said = at ? Date.parse(at) : NaN;
    // A time from the device is believed when it is in the last month and not in the future.
    const when = Number.isFinite(said) && said <= now && now - said < 31 * 24 * 60 * 60 * 1000 ? said : now;
    mkdirSync(this.historyDir, { recursive: true, mode: 0o700 });
    appendFileSync(this.historyFile(userId), `${JSON.stringify({ at: new Date(when).toISOString(), track })}\n`, { mode: 0o600 });
  }

  private plays(userId: string): Play[] {
    const file = this.historyFile(userId);
    try {
      const stats = statSync(file);
      const known = this.parsed.get(file);
      if (known && known.mtimeMs === stats.mtimeMs && known.size === stats.size) return known.plays;
      const plays = readFileSync(file, 'utf8').split('\n').flatMap((line): Play[] => {
        if (!line) return [];
        try {
          const entry = JSON.parse(line) as { at?: unknown; track?: unknown };
          const track = toSavedTrack(entry.track);
          return track && typeof entry.at === 'string' ? [{ at: entry.at, track }] : [];
        } catch {
          return [];
        }
      });
      plays.sort((a, b) => a.at.localeCompare(b.at));
      this.parsed.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, plays });
      return plays;
    } catch {
      return [];
    }
  }

  /** A user's listening: the latest plays, the songs played most with how often, and the albums played lately. */
  history(userId: string): HistoryResponse {
    const plays = this.plays(userId);
    const counts = new Map<string, { track: SavedTrack; count: number; last: string }>();
    for (const play of plays) {
      const had = counts.get(play.track.id);
      counts.set(play.track.id, { track: play.track, count: (had?.count ?? 0) + 1, last: play.at });
    }
    const albums = new Map<string, { path: string; title: string; artist: string; at: string }>();
    for (let i = plays.length - 1; i >= 0 && albums.size < HISTORY_ALBUMS; i--) {
      const folder = folderOfId(plays[i].track.id);
      if (folder && !albums.has(folder)) albums.set(folder, { path: folder, title: plays[i].track.album, artist: plays[i].track.albumArtist ?? plays[i].track.artist, at: plays[i].at });
    }
    return {
      total: plays.length,
      plays: plays.slice(-HISTORY_PLAYS).reverse(),
      top: [...counts.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last)).slice(0, HISTORY_TOP).map(({ track, count }) => ({ track, count })),
      albums: [...albums.values()],
    };
  }

  /** How often a user has played each of some songs. */
  counts(userId: string, ids: string[]): Record<string, number> {
    const wanted = new Set(ids);
    const out: Record<string, number> = {};
    for (const play of this.plays(userId)) if (wanted.has(play.track.id)) out[play.track.id] = (out[play.track.id] ?? 0) + 1;
    return out;
  }

  /** A user is gone, and what they marked and heard with them. */
  removeUser(userId: string): void {
    const users = this.readFavourites();
    if (users[userId]) {
      delete users[userId];
      writeJsonAtomic(this.favouritesFile, { users });
    }
    rmSync(this.historyFile(userId), { force: true });
    this.parsed.delete(this.historyFile(userId));
  }
}
