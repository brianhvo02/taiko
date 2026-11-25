/**
 * Exact seeking for FLAC files in the library (the idea is explained in src/shared/flac.ts): where a stream that
 * plays from a given time must begin, and whether a byte offset from a request really is the start of a frame.
 *
 * Every path here must be one `LibraryPaths` resolved.
 */
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { flacStartAt, parseFrameHeader, readFlacIndex, streamHeader } from '../../src/shared/flac';
import type { FlacIndex, Reader } from '../../src/shared/flac';
import { extensionOf } from './paths';

/** How much is read at an offset to check that a frame starts there; a frame header is at most 16 bytes and its checksum. */
const FRAME_HEADER_BYTES = 32;

export function isFlacName(name: string): boolean {
  return extensionOf(name) === 'flac';
}

/** A `Reader` over an open file. It gives fewer bytes than asked at the end of the file, and none past it. */
export function fileReader(handle: FileHandle): Reader {
  return async (offset, length) => {
    if (!(length > 0) || !(offset >= 0)) return new Uint8Array(0);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    // A plain Uint8Array, not a Buffer: the shared FLAC code copies with `slice`, which on a Buffer shares memory.
    return new Uint8Array(buffer.buffer, buffer.byteOffset, read);
  };
}

export interface FlacSeek {
  /** Whether the file is a FLAC file that could be indexed. */
  exactSeek: boolean;
  /** The file's length; null without `exactSeek`. */
  totalSeconds: number | null;
  /** The time the audio starts at: 0 for the whole file. */
  startSeconds: number;
  /** The byte offset of the frame to start at; null for the whole file. */
  at: number | null;
}

const WHOLE_FILE: FlacSeek = { exactSeek: false, totalSeconds: null, startSeconds: 0, at: null };

/**
 * Where to start a file so that it plays from `fromSeconds`. A file that isn't FLAC, can't be indexed or can't be
 * read (a damaged file) is simply played whole: this never throws.
 */
export async function flacSeek(filePath: string, fromSeconds: number): Promise<FlacSeek> {
  if (!isFlacName(filePath)) return WHOLE_FILE;
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, 'r');
    const read = fileReader(handle);
    const index = await readFlacIndex(read, (await handle.stat()).size);
    if (!index) return WHOLE_FILE;
    const totalSeconds = index.totalSamples / index.sampleRate;
    const whole: FlacSeek = { exactSeek: true, totalSeconds, startSeconds: 0, at: null };
    if (!(fromSeconds > 0)) return whole;
    // A time past the end gives the last frame.
    const start = await flacStartAt(read, index, fromSeconds);
    if (start.startSample <= 0) return whole;
    return { exactSeek: true, totalSeconds, startSeconds: start.startSeconds, at: start.offset };
  } catch {
    return WHOLE_FILE;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * The 42-byte header for a stream that begins at byte `at` of an open FLAC file, or null when no frame starts there
 * (or the file isn't an indexable FLAC). The stream is this header, then the file from `at` to its end.
 */
export async function flacStreamHeader(handle: FileHandle, size: number, at: number): Promise<Uint8Array | null> {
  let index: FlacIndex | null;
  let frame: { sample: number; blockSize: number } | null;
  try {
    const read = fileReader(handle);
    index = await readFlacIndex(read, size);
    if (!index || !Number.isSafeInteger(at) || at < index.audioStart || at >= size) return null;
    frame = parseFrameHeader(await read(at, FRAME_HEADER_BYTES), 0, index);
  } catch {
    return null;
  }
  if (!frame || frame.sample >= index.totalSamples) return null;
  return streamHeader(index, frame.sample);
}
