import { open, stat } from 'node:fs/promises';
import { TAG_HEAD_BYTES, readTagsFrom } from '../../src/shared/tags';
import type { Tags } from '../../src/shared/tags';

const NO_TAGS: Tags = { title: '', artist: '', album: '', trackNumber: null, discNumber: null, durationSeconds: null };

/** The start of a file, where its tags are. */
export async function readHead(file: string, size: number): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, TAG_HEAD_BYTES));
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}

interface Entry {
  mtimeMs: number;
  size: number;
  tags: Tags;
}

/**
 * Tags for the folder browser, read when a folder is opened and remembered while the file's size and modified
 * time stay the same. Opening a folder a second time then costs one `stat` per song. Nothing is written to disk:
 * the cache starts empty with the server.
 */
export class TagCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly limit = 50_000) {}

  /** A file's tags; empty tags when it can't be read. Never throws. */
  async read(file: string): Promise<Tags> {
    try {
      const stats = await stat(file);
      const known = this.entries.get(file);
      if (known && known.mtimeMs === stats.mtimeMs && known.size === stats.size) return known.tags;
      // Through a reader, so a FLAC file's tags are found even behind a large cover picture.
      const handle = await open(file, 'r');
      let tags: Tags;
      try {
        tags = await readTagsFrom(async (offset, length) => {
          const buffer = Buffer.alloc(Math.max(0, Math.min(length, stats.size - offset)));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
        }, stats.size);
      } finally {
        await handle.close();
      }
      this.entries.delete(file);
      this.entries.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, tags });
      // The oldest entries go first once the cache is full (a Map keeps the order things were added in).
      for (const key of this.entries.keys()) {
        if (this.entries.size <= this.limit) break;
        this.entries.delete(key);
      }
      return tags;
    } catch {
      return NO_TAGS;
    }
  }

  /** Tags for many files, a few at a time, so a big folder doesn't open hundreds of files at once. */
  async readAll(files: string[], atOnce = 8): Promise<Tags[]> {
    const out: Tags[] = new Array(files.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < files.length) {
        const i = next++;
        out[i] = await this.read(files[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(atOnce, files.length) }, worker));
    return out;
  }
}
