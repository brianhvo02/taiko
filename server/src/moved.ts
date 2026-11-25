/**
 * Where songs went when an album was replaced by a fresh copy. Ringobushi, which fills a root with tagged albums,
 * appends one line to `<that root>/.ringobushi/replaced.jsonl` for each track of an old album it replaces:
 *
 *   {"event":"replaced","oldRoot":"FLAC","oldPath":"Artist/Album/01 Song.flac","newPath":"Artist/[2020] Album/01. Song.flac","appleSongId":"…","date":"…"}
 *
 * `oldRoot` is one of this server's root names and `oldPath` the file's path under it; `newPath` is under the
 * root that holds the record, and is empty when the fresh album has no such track. Other events (`deleted`, when
 * the old folder goes) and other fields are ignored: whether a song has moved is read from the disk, not from the
 * record (see `POST moved` in app.ts). A later line for the same old file wins. A line that can't be read is
 * skipped. The server only ever reads this file.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { LibraryRoot } from './config';

export const RECORD_PATH = ['.ringobushi', 'replaced.jsonl'];

/** Old file (`Root/path`) to new file (`Root/path`, or '' for none), from one root's record. */
export function parseMoved(text: string, rootName: string): Map<string, string> {
  const moved = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const { event, oldRoot, oldPath, newPath } = entry as Record<string, unknown>;
    if ((event !== undefined && event !== 'replaced') || typeof oldRoot !== 'string' || typeof oldPath !== 'string' || !oldRoot || !oldPath) continue;
    const clean = (value: string) => value.replace(/^\/+/, '');
    moved.set(`${oldRoot}/${clean(oldPath)}`, typeof newPath === 'string' && newPath ? `${rootName}/${clean(newPath)}` : '');
  }
  return moved;
}

interface Read {
  mtimeMs: number;
  size: number;
  moved: Map<string, string>;
}

/** The records of every root, read again only when a file changes. */
export class MovedRecord {
  private readonly read = new Map<string, Read>();

  constructor(private readonly roots: readonly LibraryRoot[]) {}

  private async of(root: LibraryRoot): Promise<Map<string, string> | null> {
    const file = path.join(root.dir, ...RECORD_PATH);
    try {
      const stats = await stat(file);
      const known = this.read.get(file);
      if (known && known.mtimeMs === stats.mtimeMs && known.size === stats.size) return known.moved;
      const moved = parseMoved(await readFile(file, 'utf8'), root.name);
      this.read.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, moved });
      return moved;
    } catch {
      return null; // No record in this root, or it can't be read.
    }
  }

  /** Where the file at `Root/path` went: its new `Root/path`, '' when it has none, undefined when no record names it. */
  async lookup(oldFile: string): Promise<string | undefined> {
    for (const root of this.roots) {
      const found = (await this.of(root))?.get(oldFile);
      if (found !== undefined) return found;
    }
    return undefined;
  }
}
