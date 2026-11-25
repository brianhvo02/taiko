/**
 * From what a request names (a track id, a browse path) to a file or folder in the library, safely.
 *
 * A track id is the base64url of `<root name>/<path under the root>`, and a browse path is that text itself, so both
 * come from the device and neither is trusted. Everything the server opens for a request goes through
 * `LibraryPaths`: the path's parts are checked one by one, joined onto a configured root, and the result's real path
 * (links followed) must still be inside the root's real path. The library is only ever read.
 *
 * The folder listing here (`listFolder`) is the one the browser, the lyrics route and the scan all use, so a lyrics
 * index means the same file everywhere.
 */
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AUDIO_EXTENSIONS, LYRICS_EXTENSIONS, lyricsBelongTo } from '../../src/shared/api';
import type { LibraryRoot } from './config';

/** Lyrics files larger than this are neither listed nor served. */
export const MAX_LYRICS_BYTES = 5 * 1024 * 1024;
/** Longer ids and paths are refused unread. */
const MAX_PATH_CHARS = 4096;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function stemOf(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

export function isAudioName(name: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

function isLyricsName(name: string): boolean {
  return (LYRICS_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

/** Dot-folders and dot-files, and the folders a NAS keeps for itself (thumbnails, recycle bins). Never listed or served. */
export function skippedName(name: string): boolean {
  const lower = name.toLowerCase();
  return name.startsWith('.') || name.startsWith('@') || lower === '#recycle' || lower === '$recycle.bin';
}

/** Whether one part of a path from a request may be used as a file or folder name. */
function safeSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..') return false;
  if (segment.includes('\\') || segment.includes('\0') || segment.includes('/')) return false;
  // "C:" and "C:name" mean a drive on Windows, and any other colon there names a file's alternate stream.
  if (/^[A-Za-z]:/.test(segment) || (process.platform === 'win32' && segment.includes(':'))) return false;
  return !skippedName(segment);
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** The id of the file at `parts` (folder names, then the file name) under a root. */
export function encodeTrackId(rootName: string, parts: string[]): string {
  return Buffer.from([rootName, ...parts].join('/'), 'utf8').toString('base64url');
}

/** The path an id names, or null when the id isn't the base64url of UTF-8 text. */
export function decodeTrackId(id: string): string | null {
  if (!id || id.length > MAX_PATH_CHARS || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(id, 'base64url'));
    // Only the one spelling of an id is accepted, so a ticket signed for it can't be replayed under another.
    return Buffer.from(text, 'utf8').toString('base64url') === id ? text : null;
  } catch {
    return null;
  }
}

export interface FolderEntry {
  name: string;
  /** Absolute, with links followed. */
  path: string;
}

export interface AudioEntry extends FolderEntry {
  /** The lyrics files beside the song, sorted by name; a lyrics index is a position here. */
  lyrics: FolderEntry[];
}

export interface FolderListing {
  /** True when the folder has nothing in it at all (an unmounted drive's mount point). */
  empty: boolean;
  folders: FolderEntry[];
  audio: AudioEntry[];
}

const byName = (a: FolderEntry, b: FolderEntry): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * One folder, from one `readdir`: its sub-folders and its audio files with their lyrics, all sorted by name (code
 * point order). `dir` must already be a real path inside `rootReal`. A link is listed only while what it points at
 * is still inside the root. Tags are not read. Throws when the folder can't be read.
 */
export async function listFolder(dir: string, rootReal: string): Promise<FolderListing> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: FolderEntry[] = [];
  const folders: FolderEntry[] = [];
  for (const entry of entries) {
    if (skippedName(entry.name)) continue;
    let target = path.join(dir, entry.name);
    let isFile = entry.isFile();
    let isFolder = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        target = await realpath(target);
        if (!inside(rootReal, target)) continue;
        const stats = await stat(target);
        isFile = stats.isFile();
        isFolder = stats.isDirectory();
      } catch {
        continue;
      }
    }
    if (isFile) files.push({ name: entry.name, path: target });
    else if (isFolder) folders.push({ name: entry.name, path: target });
  }
  files.sort(byName);
  folders.sort(byName);

  const audio: AudioEntry[] = files.filter((file) => isAudioName(file.name)).map((file) => ({ ...file, lyrics: [] }));
  if (audio.length) {
    for (const file of files) {
      if (!isLyricsName(file.name)) continue;
      // When two songs both match a lyrics file by name ("Song.flac" and "Song_live.flac" both match
      // "Song_live.lrc"), it goes to the one with the longer name.
      const owners = audio.filter((song) => lyricsBelongTo(file.name, song.name));
      if (!owners.length) continue;
      const longest = Math.max(...owners.map((song) => stemOf(song.name).length));
      try {
        const stats = await stat(file.path);
        if (!stats.isFile() || stats.size > MAX_LYRICS_BYTES) continue;
      } catch {
        continue; // Gone since the folder was listed.
      }
      for (const song of owners) {
        if (stemOf(song.name).length === longest) song.lyrics.push(file);
      }
    }
  }
  return { empty: entries.length === 0, folders, audio };
}

export interface ResolvedFolder {
  root: LibraryRoot;
  /** The root's real path, for `listFolder`. */
  rootReal: string;
  /** The folder names under the root; empty for the root itself. */
  parts: string[];
  /** Absolute, with links followed, and inside `rootReal`. */
  real: string;
}

export interface ResolvedTrack {
  /** The audio file: absolute, with links followed, inside its root. */
  audioPath: string;
  /** The folder the id names the file in. */
  folder: ResolvedFolder;
  /** The file's name in that folder. */
  name: string;
}

export class LibraryPaths {
  constructor(private readonly roots: readonly LibraryRoot[]) {}

  private split(text: string): { root: LibraryRoot; parts: string[] } | null {
    if (!text || text.length > MAX_PATH_CHARS) return null;
    const [rootName, ...parts] = text.split('/');
    const root = this.roots.find((candidate) => candidate.name === rootName);
    if (!root || !parts.every(safeSegment)) return null;
    return { root, parts };
  }

  private async folder(root: LibraryRoot, parts: string[]): Promise<ResolvedFolder | null> {
    try {
      const rootReal = await realpath(root.dir);
      const real = await realpath(path.join(rootReal, ...parts));
      if (!inside(rootReal, real) || !(await stat(real)).isDirectory()) return null;
      return { root, rootReal, parts, real };
    } catch {
      return null; // Missing, unreadable, or a link to nowhere.
    }
  }

  /** The folder a browse path (`Root/Folder/Folder`) names, or null. */
  async resolveFolder(browsePath: string): Promise<ResolvedFolder | null> {
    const split = this.split(browsePath);
    return split ? this.folder(split.root, split.parts) : null;
  }

  /** The audio file a track id names, or null: a regular file with an audio extension, inside its root. */
  async resolveTrack(id: string): Promise<ResolvedTrack | null> {
    const text = decodeTrackId(id);
    const split = text === null ? null : this.split(text);
    if (!split || !split.parts.length) return null;
    const name = split.parts[split.parts.length - 1];
    if (!isAudioName(name)) return null;
    const folder = await this.folder(split.root, split.parts.slice(0, -1));
    if (!folder) return null;
    try {
      const audioPath = await realpath(path.join(folder.real, name));
      if (!inside(folder.rootReal, audioPath) || !(await stat(audioPath)).isFile()) return null;
      return { audioPath, folder, name };
    } catch {
      return null;
    }
  }

  /** The lyrics files of a resolved track, in the order the browser lists them. */
  async lyricsOf(track: ResolvedTrack): Promise<FolderEntry[]> {
    try {
      const listing = await listFolder(track.folder.real, track.folder.rootReal);
      return listing.audio.find((song) => song.name === track.name)?.lyrics ?? [];
    } catch {
      return [];
    }
  }
}
