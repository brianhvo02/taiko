import { lstat, open, readdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';

/** An album folder's picture: cover, folder or front, as a JPEG, PNG or WebP. */
const NAMES = /^(cover|folder|front)\.(jpe?g|png|webp)$/i;
const TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const RANK = ['cover', 'folder', 'front'];

/** A picture larger than this is not an album cover; it is left out. */
export const MAX_COVER_BYTES = 30 * 1024 * 1024;

export interface Cover {
  path: string;
  type: string;
  size: number;
}

/**
 * The cover picture in a folder, if it has one: "cover" before "folder" before "front". Only a regular file
 * counts (never a link), and it is served as it is, at its own size; the server has nothing to resize it with.
 */
export async function findCover(dir: string): Promise<Cover | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const rank = (name: string) => RANK.indexOf(name.slice(0, name.lastIndexOf('.')).toLowerCase());
  const candidates = names.filter((name) => NAMES.test(name)).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  for (const name of candidates) {
    const file = path.join(dir, name);
    try {
      const stats = await lstat(file);
      if (stats.isFile() && stats.size > 0 && stats.size <= MAX_COVER_BYTES) {
        return { path: file, type: TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()], size: stats.size };
      }
    } catch {
      // Gone since the listing; try the next.
    }
  }
  return null;
}

/** Sends a cover. Resolves to false, with nothing sent, when the file can't be opened. */
export async function sendCover(req: IncomingMessage, res: ServerResponse, cover: Cover): Promise<boolean> {
  let handle;
  try {
    handle = await open(cover.path, 'r');
  } catch {
    return false;
  }
  const size = (await handle.stat()).size;
  res.writeHead(200, {
    'Content-Type': cover.type,
    'Content-Length': size,
    // The address changes once a day (app.ts), so a browser keeps the picture for the day.
    'Cache-Control': 'private, max-age=86400',
  });
  if (req.method === 'HEAD' || size === 0) {
    await handle.close();
    res.end();
    return true;
  }
  // Closed by name whenever the stream ends, fails, or the browser gives up on the picture (see ranges.ts).
  const file = handle;
  const stream = file.createReadStream({ autoClose: false });
  const finish = (): void => {
    stream.destroy();
    void file.close().catch(() => {});
  };
  res.once('close', finish);
  pipeline(stream, res, finish);
  return true;
}
