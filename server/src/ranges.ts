/** Audio files over HTTP: the `Range` header, content types, and the streamed response. */
import { open } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';
import { flacStreamHeader, isFlacName } from './flac-file';

export type RangeResult =
  | { kind: 'full' }
  /** Both ends inclusive. */
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * Reads a single `Range: bytes=` header against a file of `size` bytes: `start-end`, `start-` and `-suffix`.
 * A header that isn't understood (another unit, several ranges, an end before the start) is ignored, as HTTP allows,
 * and the whole file is sent.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined) return { kind: 'full' };
  const match = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return { kind: 'full' };
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix)) return { kind: 'full' };
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { kind: 'full' };
  if (match[2] !== '' && end < start) return { kind: 'full' };
  if (start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: Math.min(end, size - 1) };
}

const AUDIO_TYPES: Record<string, string> = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
};

/** The content type for an audio file's name or path. */
export function audioContentType(fileName: string): string {
  const extension = /\.([^./\\]+)$/.exec(fileName)?.[1].toLowerCase() ?? '';
  return AUDIO_TYPES[extension] ?? 'application/octet-stream';
}

export type SendResult = 'sent' | 'missing' | 'bad-start';

/**
 * Answers a GET or HEAD with an audio file, honouring `Range`. `filePath` must be one `LibraryPaths` resolved,
 * never text from the request.
 *
 * With `at` (a byte offset from the request) the answer is a FLAC stream that begins at the frame there: a 42-byte
 * header, then the file from `at` to its end, with ranges counted over that whole stream.
 *
 * Nothing is sent unless the result is `sent`: `missing` when the file can't be opened (the caller answers 404),
 * `bad-start` when no FLAC frame starts at `at` (the caller answers 400).
 */
export async function sendAudioFile(req: IncomingMessage, res: ServerResponse, filePath: string, at?: number): Promise<SendResult> {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    return 'missing';
  }
  let handedOver = false;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return 'missing';

    // What is served: `prefix`, then the file's bytes from `bodyStart` on.
    let prefix: Uint8Array = new Uint8Array(0);
    let bodyStart = 0;
    if (at !== undefined) {
      const header = isFlacName(filePath) ? await flacStreamHeader(handle, stats.size, at) : null;
      if (!header) return 'bad-start';
      prefix = header;
      bodyStart = at;
    }
    const size = prefix.length + (stats.size - bodyStart);

    const range = parseRange(req.headers.range, size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');

    if (range.kind === 'unsatisfiable') {
      const body = JSON.stringify({ error: 'range-not-satisfiable' });
      res.writeHead(416, {
        'Content-Range': `bytes */${size}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return 'sent';
    }

    const start = range.kind === 'partial' ? range.start : 0;
    const end = range.kind === 'partial' ? range.end : size - 1;
    const length = end - start + 1;
    res.setHeader('Content-Type', audioContentType(filePath));
    res.setHeader('Content-Length', length);
    if (range.kind === 'partial') res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.writeHead(range.kind === 'partial' ? 206 : 200);

    if (req.method === 'HEAD' || length === 0) {
      res.end();
      return 'sent';
    }
    // The range may lie in the prefix, in the file, or across both.
    const head = prefix.subarray(Math.min(start, prefix.length), Math.min(end + 1, prefix.length));
    if (end < prefix.length) {
      res.end(head);
      return 'sent';
    }
    if (head.length) res.write(head);
    const from = bodyStart + Math.max(start, prefix.length) - prefix.length;
    const to = bodyStart + end - prefix.length;
    // Streamed, never held in memory. The stream closes the handle when it ends or fails; a listener hanging up
    // mid-song ends it too.
    handedOver = true;
    pipeline(handle.createReadStream({ start: from, end: to }), res, () => {});
    return 'sent';
  } finally {
    if (!handedOver) await handle.close().catch(() => {});
  }
}
