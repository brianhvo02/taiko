/**
 * The library: the albums and songs in the roots `LIBRARY_SCAN` names, from the songs' tags. The other roots are
 * reached through the folder browser only; a `Library` given no roots is off and stays empty.
 *
 * An album is a folder that directly holds audio files. The scan only lists: playing a song never consults it (a
 * track id names its file, and `paths.ts` resolves it), and an album's songs come from `browse` on its folder.
 * Tags are read through the `TagCache` the folder browser uses, so opening a scanned album reads no file again.
 */
import { realpath, stat } from 'node:fs/promises';
import type { LyricsFormat, NasAlbum, NasTrack } from '../../src/shared/api';
import type { Tags } from '../../src/shared/tags';
import type { LibraryRoot } from './config';
import { findCover } from './cover';
import { byNameNumeric, encodeTrackId, extensionOf, listFolder, stemOf } from './paths';
import type { AudioEntry, FolderEntry, FolderListing } from './paths';
import type { TagCache } from './tag-cache';

/** Folders below a root are followed this many levels down (the root itself is level 0). */
export const MAX_DEPTH = 8;
/** `search` gives at most this many songs. */
export const SEARCH_LIMIT = 50;

/** A track's `lyrics`, from the files `listFolder` found beside it. */
export function lyricsList(lyrics: FolderEntry[]): NasTrack['lyrics'] {
  return lyrics.map((file, index) => ({ index, name: file.name, format: extensionOf(file.name) as LyricsFormat }));
}

/** The other forms of a song's names that its tags carry, leaving out the ones it doesn't have. */
export function otherNames(tags: Tags): Partial<Tags> {
  const out: Partial<Tags> = {};
  for (const key of ['titleRoman', 'artistRoman', 'albumRoman', 'titleEnglish', 'artistEnglish', 'albumEnglish', 'appleSongId', 'albumArtist', 'albumArtistRoman', 'date'] as const) {
    if (tags[key]) out[key] = tags[key];
  }
  return out;
}

/** A song as the folder browser, the library and the search all list it. `folder` is the root's name and the folders under it. */
export function nasTrack(folder: string[], file: AudioEntry, tags: Tags): NasTrack {
  return {
    id: encodeTrackId(folder[0], [...folder.slice(1), file.name]),
    title: tags.title || stemOf(file.name),
    artist: tags.artist,
    album: tags.album,
    trackNumber: tags.trackNumber,
    discNumber: tags.discNumber,
    durationSeconds: tags.durationSeconds,
    ...otherNames(tags),
    lyrics: lyricsList(file.lyrics),
  };
}

/** An album as the scan keeps it. The cover's address changes by the day, so it is made when the library is asked for. */
export type LibraryAlbum = Omit<NasAlbum, 'cover'> & { hasCover: boolean };

/** One song of a folder, for `albumOf`: its tags and when its file last changed. */
export interface AlbumSong {
  tags: Tags;
  mtimeMs: number;
}

/** The value most of `values` share, leaving out the empty ones; on a tie, the one met first. */
function commonest(values: (string | undefined)[]): string {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = '';
  let most = 0;
  // A Map keeps the order its keys were first added in, so the first of several equals wins.
  for (const [value, count] of counts) {
    if (count > most) {
      best = value;
      most = count;
    }
  }
  return best;
}

function firstOf(songs: AlbumSong[], key: 'albumRoman' | 'albumEnglish' | 'albumArtistRoman' | 'artistRoman' | 'artistEnglish' | 'date'): string | undefined {
  for (const song of songs) if (song.tags[key]) return song.tags[key];
  return undefined;
}

/**
 * What a folder's songs say their album is. `songs` are in file-name order and there is at least one.
 * `path` is the folder as the browser names it, `folderName` its own name.
 */
export function albumOf(path: string, folderName: string, songs: AlbumSong[], hasCover: boolean): LibraryAlbum {
  const tagged = commonest(songs.map((song) => song.tags.album));
  // The songs that carry the title; all of them when the title is only the folder's name.
  const titled = tagged ? songs.filter((song) => song.tags.album === tagged) : songs;
  const titleRoman = tagged ? firstOf(titled, 'albumRoman') : undefined;
  const titleEnglish = tagged ? firstOf(titled, 'albumEnglish') : undefined;

  // The album's own artist where the songs name one; else the artist every song shares; else none (a compilation).
  const albumArtist = commonest(songs.map((song) => song.tags.albumArtist));
  const shared = songs[0].tags.artist && songs.every((song) => song.tags.artist === songs[0].tags.artist) ? songs[0].tags.artist : '';
  const artist = albumArtist || shared;
  const artistRoman = albumArtist
    ? firstOf(songs.filter((song) => song.tags.albumArtist === albumArtist), 'albumArtistRoman')
    : shared ? firstOf(songs, 'artistRoman') : undefined;
  const artistEnglish = artist ? firstOf(songs.filter((song) => song.tags.artist === artist), 'artistEnglish') : undefined;

  const lengths = songs.map((song) => song.tags.durationSeconds);
  return {
    path,
    title: tagged || folderName,
    ...(titleRoman ? { titleRoman } : {}),
    ...(titleEnglish ? { titleEnglish } : {}),
    artist,
    ...(artistRoman ? { artistRoman } : {}),
    ...(artistEnglish ? { artistEnglish } : {}),
    date: firstOf(titled, 'date') ?? '',
    trackCount: songs.length,
    durationSeconds: lengths.every((length) => length !== null) ? lengths.reduce<number>((sum, length) => sum + (length ?? 0), 0) : null,
    hasCover,
    addedAt: Math.max(...songs.map((song) => song.mtimeMs)),
  };
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * By artist (albums with none last), then date, then title. Names sort by their reading in Latin script when they
 * have one, so Japanese names fall in among the others by their romaji.
 */
export function compareAlbums(a: LibraryAlbum, b: LibraryAlbum): number {
  return (
    Number(!a.artist) - Number(!b.artist) ||
    collator.compare(a.artistRoman ?? a.artist, b.artistRoman ?? b.artist) ||
    // An artist's undated albums come after the dated ones.
    Number(!a.date) - Number(!b.date) ||
    collator.compare(a.date, b.date) ||
    collator.compare(a.titleRoman ?? a.title, b.titleRoman ?? b.title) ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
}

/** Text as the search compares it: full-width letters, ligatures and the like folded to their plain forms, in lower case. */
function folded(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

interface ScannedAlbum {
  album: LibraryAlbum;
  /** In file-name order, as `browse` lists them. */
  tracks: NasTrack[];
}

interface SearchEntry {
  track: NasTrack;
  /** The title in all its forms, folded. */
  title: string;
  /** Every name the search looks in, folded. */
  all: string;
}

export class Library {
  /** Whether there is a library at all: false when no root is scanned. */
  readonly enabled: boolean;
  /** Whether a scan is running now. */
  scanning = false;
  /** ISO time of the last finished scan, or null before the first one finishes (always, while the library is off). */
  scannedAt: string | null = null;
  /** Sorted by artist, then date, then title. */
  albums: LibraryAlbum[] = [];
  /** Every scanned song: album by album in the albums' order, each album's songs in file-name order. */
  tracks: NasTrack[] = [];

  private searchable: SearchEntry[] = [];
  private readonly byRoot = new Map<string, ScannedAlbum[]>();
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private logged = '';

  /** `roots` are the roots to scan (none: the library is off); `tags` is the cache the folder browser reads through. */
  constructor(
    private readonly roots: LibraryRoot[],
    private readonly tags: TagCache,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.enabled = roots.length > 0;
  }

  /** Starts a scan unless one is running or the library is off. Says whether it started one; never waits for it. */
  scan(): boolean {
    if (!this.enabled || this.running) return false;
    this.scanning = true;
    this.running = this.scanAll()
      .catch((error) => this.log(`library: the scan failed: ${String(error)}`))
      .finally(() => {
        this.running = null;
        this.scanning = false;
      });
    return true;
  }

  /** Resolves when no scan is running: at once, or when the running one finishes. */
  async idle(): Promise<void> {
    await this.running;
  }

  /** Rescans every `minutes`; 0 never rescans. */
  startRescans(minutes: number): void {
    this.stopRescans();
    if (minutes <= 0 || !this.enabled) return;
    this.timer = setInterval(() => this.scan(), minutes * 60_000);
    this.timer.unref();
  }

  stopRescans(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The songs matching every word of `query`, in any of their names: those whose title holds every word first, then
   * the rest, each group in library order. At most `SEARCH_LIMIT`.
   */
  search(query: string): NasTrack[] {
    const words = folded(query).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const inTitle: NasTrack[] = [];
    const elsewhere: NasTrack[] = [];
    for (const entry of this.searchable) {
      if (!words.every((word) => entry.all.includes(word))) continue;
      if (words.every((word) => entry.title.includes(word))) {
        inTitle.push(entry.track);
        if (inTitle.length >= SEARCH_LIMIT) break;
      } else if (elsewhere.length < SEARCH_LIMIT) {
        elsewhere.push(entry.track);
      }
    }
    return [...inTitle, ...elsewhere].slice(0, SEARCH_LIMIT);
  }

  private async scanAll(): Promise<void> {
    for (const root of this.roots) {
      const previous = this.byRoot.get(root.name) ?? [];
      try {
        const found = await this.scanRoot(root);
        // A missing or empty root (an unmounted drive leaves an empty folder) keeps the albums of its last scan.
        if (found === null) {
          if (previous.length) this.log(`library: "${root.name}" (${root.dir}) is empty; keeping its ${previous.length} albums from the last scan`);
          else this.byRoot.set(root.name, []);
        } else {
          this.byRoot.set(root.name, found);
        }
      } catch (error) {
        this.log(`library: can't read "${root.name}" (${root.dir}); keeping its ${previous.length} albums from the last scan: ${String(error)}`);
      }
    }
    const scanned = this.roots.flatMap((root) => this.byRoot.get(root.name) ?? []).sort((a, b) => compareAlbums(a.album, b.album));
    this.albums = scanned.map((entry) => entry.album);
    this.tracks = scanned.flatMap((entry) => entry.tracks);
    this.searchable = this.tracks.map((track) => ({
      track,
      title: [track.title, track.titleRoman, track.titleEnglish].filter(Boolean).map((name) => folded(name!)).join('\n'),
      all: [
        track.title, track.titleRoman, track.titleEnglish, track.artist, track.artistRoman, track.artistEnglish,
        track.album, track.albumRoman, track.albumEnglish, track.albumArtist,
      ].filter(Boolean).map((name) => folded(name!)).join('\n'),
    }));
    this.scannedAt = new Date().toISOString();
    // One line per scan, and only when it found something different.
    const counts = `${this.albums.length} albums, ${this.tracks.length} songs`;
    if (counts !== this.logged) this.log(`library: ${counts}`);
    this.logged = counts;
  }

  /** The root's albums; null when the root folder has nothing in it. Throws when the root can't be read. */
  private async scanRoot(root: LibraryRoot): Promise<ScannedAlbum[] | null> {
    const rootReal = await realpath(root.dir);
    const listing = await listFolder(rootReal, rootReal);
    if (listing.empty) return null;
    const out: ScannedAlbum[] = [];
    await this.scanFolder(rootReal, rootReal, [root.name], listing, new Set([rootReal]), out);
    return out;
  }

  /** `here` is the root's name and the folders under it; `dir` is that folder's real path. */
  private async scanFolder(rootReal: string, dir: string, here: string[], listing: FolderListing, visited: Set<string>, out: ScannedAlbum[]): Promise<void> {
    if (listing.audio.length) {
      const album = await this.scanAlbum(dir, here, listing.audio);
      if (album) out.push(album);
    }
    if (here.length > MAX_DEPTH) return;
    for (const folder of listing.folders) {
      // A link back to a folder already scanned would list its songs twice (or loop).
      if (visited.has(folder.path)) continue;
      visited.add(folder.path);
      let inner: FolderListing;
      try {
        inner = await listFolder(folder.path, rootReal);
      } catch (error) {
        this.log(`library: skipping a folder that can't be read: ${folder.path}: ${String(error)}`);
        continue;
      }
      await this.scanFolder(rootReal, folder.path, [...here, folder.name], inner, visited, out);
    }
  }

  private async scanAlbum(dir: string, here: string[], audio: AudioEntry[]): Promise<ScannedAlbum | null> {
    const files = [...audio].sort(byNameNumeric);
    const read = await this.tags.readAll(files.map((file) => file.path));
    const songs: AlbumSong[] = [];
    const tracks: NasTrack[] = [];
    for (let i = 0; i < files.length; i++) {
      try {
        songs.push({ tags: read[i], mtimeMs: (await stat(files[i].path)).mtimeMs });
        tracks.push(nasTrack(here, files[i], read[i]));
      } catch {
        // Gone since the folder was listed.
      }
    }
    if (!songs.length) return null;
    return { album: albumOf(here.join('/'), here[here.length - 1], songs, (await findCover(dir)) !== null), tracks };
  }
}
