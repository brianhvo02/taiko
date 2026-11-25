/** For the tests only: temporary folders and tiny fake audio files. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'taiko-server-test-'));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** Writes a file, making its folders. */
export function writeFile(file: string, content: string | Uint8Array): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/**
 * A FLAC file's metadata (STREAMINFO for 10 seconds at 44100 Hz, then a Vorbis comment block) followed by `extra`
 * bytes standing in for the audio.
 */
export function fakeFlac(comments: string[], extra = 0): Buffer {
  const info = Buffer.alloc(34);
  info[10] = 0x0a; info[11] = 0xc4; info[12] = 0x42;
  info[13] = 0xf0;
  info.writeUInt32BE(441000, 14);
  const le32 = (n: number): Buffer => {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(n);
    return out;
  };
  const be24 = (n: number): number[] => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const vendor = Buffer.from('test');
  const body = Buffer.concat([
    le32(vendor.length), vendor, le32(comments.length),
    ...comments.flatMap((comment) => [le32(Buffer.byteLength(comment)), Buffer.from(comment)]),
  ]);
  const audio = Buffer.from(Array.from({ length: extra }, (_, i) => (i * 7 + 3) & 0xff));
  return Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x00, ...be24(34)]), info, Buffer.from([0x84, ...be24(body.length)]), body, audio]);
}
