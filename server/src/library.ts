/**
 * The tag-based library: a scan of the roots into a list of tracks. Runs only while `LIBRARY_SCAN` is on; a
 * `Library` that never scans stays empty, with `scannedAt` null.
 *
 * The scan only lists. Serving a track never consults it: a track id names its file, and `paths.ts` resolves it.
 */
import { realpath, stat } from 'node:fs/promises';
import type { LyricsFormat, NasTrack } from '../../src/shared/api';
import { readTags } from '../../src/shared/tags';
import { readHead } from './tag-cache';
import type { LibraryRoot } from './config';
import { encodeTrackId, extensionOf, listFolder, stemOf } from './paths';
import type { AudioEntry, FolderEntry, FolderListing } from './paths';

/** Folders below a root are followed this many levels down (the root itself is level 0). */
export const MAX_DEPTH = 8;

interface ScannedTrack {
  track: NasTrack;
  audioPath: string;
  /** With `size`, tells an unchanged file, whose tags needn't be read again. */
  mtimeMs: number;
  size: number;
}

/** A track's `lyrics`, from the files `listFolder` found beside it. */
export function lyricsList(lyrics: FolderEntry[]): NasTrack['lyrics'] {
  return lyrics.map((file, index) => ({ index, name: file.name, format: extensionOf(file.name) as LyricsFormat }));
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

export function compareTracks(a: NasTrack, b: NasTrack): number {
  return (
    collator.compare(a.artist, b.artist) ||
    collator.compare(a.album, b.album) ||
    (a.discNumber ?? 0) - (b.discNumber ?? 0) ||
    (a.trackNumber ?? 0) - (b.trackNumber ?? 0) ||
    collator.compare(a.title, b.title) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}


export class Library {
  /** Sorted by artist, album, disc, track number, title. */
  tracks: NasTrack[] = [];
  /** ISO time of the last finished scan, or null before the first one finishes (always, while the scan is off). */
  scannedAt: string | null = null;

  private readonly byRoot = new Map<string, ScannedTrack[]>();
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly roots: LibraryRoot[],
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Scans every root. A scan asked for while one runs joins the running one. */
  scan(): Promise<void> {
    this.running ??= this.scanAll().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Rescans every `minutes`; 0 never rescans. */
  startRescans(minutes: number): void {
    this.stopRescans();
    if (minutes <= 0) return;
    this.timer = setInterval(() => {
      this.scan().catch((error) => this.log(`library: the scan failed: ${String(error)}`));
    }, minutes * 60_000);
    this.timer.unref();
  }

  stopRescans(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async scanAll(): Promise<void> {
    for (const root of this.roots) {
      const previous = this.byRoot.get(root.name) ?? [];
      try {
        const found = await this.scanRoot(root, previous);
        // A missing or empty root (an unmounted drive leaves an empty folder) keeps the tracks of its last scan.
        if (found === null) {
          if (previous.length) this.log(`library: "${root.name}" (${root.dir}) is empty; keeping its ${previous.length} tracks from the last scan`);
          else this.byRoot.set(root.name, []);
        } else {
          this.byRoot.set(root.name, found);
        }
      } catch (error) {
        this.log(`library: can't read "${root.name}" (${root.dir}); keeping its ${previous.length} tracks from the last scan: ${String(error)}`);
      }
    }
    const tracks = this.roots.flatMap((root) => (this.byRoot.get(root.name) ?? []).map((scanned) => scanned.track));
    tracks.sort(compareTracks);
    this.tracks = tracks;
    this.scannedAt = new Date().toISOString();
  }

  /** The root's tracks; null when the root folder has nothing in it. Throws when the root can't be read. */
  private async scanRoot(root: LibraryRoot, previous: ScannedTrack[]): Promise<ScannedTrack[] | null> {
    const rootReal = await realpath(root.dir);
    const listing = await listFolder(rootReal, rootReal);
    if (listing.empty) return null;
    const known = new Map(previous.map((scanned) => [scanned.audioPath, scanned]));
    const out: ScannedTrack[] = [];
    await this.scanFolder(root, rootReal, [], listing, known, new Set([rootReal]), out);
    return out;
  }

  private async scanFolder(
    root: LibraryRoot,
    rootReal: string,
    relative: string[],
    listing: FolderListing,
    known: Map<string, ScannedTrack>,
    visited: Set<string>,
    out: ScannedTrack[],
  ): Promise<void> {
    for (const file of listing.audio) {
      try {
        out.push(await this.scanFile(root, relative, file, known));
      } catch (error) {
        this.log(`library: skipping a file that can't be read: ${file.path}: ${String(error)}`);
      }
    }
    if (relative.length >= MAX_DEPTH) return;
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
      await this.scanFolder(root, rootReal, [...relative, folder.name], inner, known, visited, out);
    }
  }

  private async scanFile(root: LibraryRoot, relative: string[], file: AudioEntry, known: Map<string, ScannedTrack>): Promise<ScannedTrack> {
    const stats = await stat(file.path);
    const id = encodeTrackId(root.name, [...relative, file.name]);
    const before = known.get(file.path);
    const tags = before && before.mtimeMs === stats.mtimeMs && before.size === stats.size && before.track.id === id
      ? before.track
      : readTags(await readHead(file.path, stats.size));
    return {
      audioPath: file.path,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      track: {
        id,
        title: tags.title || stemOf(file.name),
        artist: tags.artist,
        album: tags.album,
        trackNumber: tags.trackNumber,
        discNumber: tags.discNumber,
        durationSeconds: tags.durationSeconds,
        lyrics: lyricsList(file.lyrics),
      },
    };
  }
}
