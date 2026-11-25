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

export const FLAC_BLOCK = 4096;
export const FLAC_RATE = 44100;

export interface SeekableFlac {
  bytes: Buffer;
  /** Where each frame starts in the file; frame n starts at sample n * FLAC_BLOCK. */
  offsets: number[];
  audioStart: number;
  totalSamples: number;
}

/**
 * A FLAC file of `frames` stereo 16-bit frames of 4096 samples at 44100 Hz: real metadata and real frame headers
 * around made-up audio data (after `makeFlac` in src/shared/flac.test.ts). It has no seek table.
 */
export function seekableFlac(frames: number): SeekableFlac {
  const crc8 = (bytes: number[]): number => {
    let crc = 0;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
    return crc;
  };
  // A number in FLAC's UTF-8-like coding.
  const coded = (value: number): number[] => {
    if (value < 0x80) return [value];
    const bytes: number[] = [];
    let rest = value;
    let lead = 0xc0;
    let room = 0x20;
    while (rest >= room) {
      bytes.unshift(0x80 | (rest % 64));
      rest = Math.floor(rest / 64);
      lead = (lead >> 1) | 0x80;
      room >>= 1;
    }
    bytes.unshift(0x80 | (rest % 64));
    rest = Math.floor(rest / 64);
    return [lead | rest, ...bytes];
  };
  // A small deterministic generator, so the made-up audio data is the same on every run.
  let state = 7;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state >>> 24;
  };

  const totalSamples = frames * FLAC_BLOCK;
  const info = Buffer.alloc(34);
  info.writeUInt16BE(FLAC_BLOCK, 0);
  info.writeUInt16BE(FLAC_BLOCK, 2);
  info[10] = FLAC_RATE >> 12; info[11] = (FLAC_RATE >> 4) & 0xff; info[12] = ((FLAC_RATE & 0x0f) << 4) | (1 << 1); // 2 channels
  info[13] = 15 << 4; // 16 bits per sample
  info.writeUInt32BE(totalSamples, 14);
  info.fill(0xab, 18); // a checksum the stream header must clear
  const comment = [4, 0, 0, 0, 0x74, 0x65, 0x73, 0x74, 0, 0, 0, 0];
  const meta = Buffer.from([0x66, 0x4c, 0x61, 0x43, 0x00, 0, 0, 34, ...info, 0x84, 0, 0, comment.length, ...comment]);

  const parts: Buffer[] = [meta];
  const offsets: number[] = [];
  let at = meta.length;
  for (let n = 0; n < frames; n++) {
    // sync, block size code 12 (4096) and rate code 9 (44.1 kHz), stereo and 16 bits, the frame number, the checksum
    const head = [0xff, 0xf8, (12 << 4) | 9, (1 << 4) | (4 << 1), ...coded(n)];
    head.push(crc8(head));
    const length = 600 + random() * 9 + random();
    // No 0xFF in the data, so only real headers carry a sync code.
    const frame = Buffer.from([...head, ...Array.from({ length }, () => Math.min(random(), 0xfe))]);
    offsets.push(at);
    at += frame.length;
    parts.push(frame);
  }
  return { bytes: Buffer.concat(parts), offsets, audioStart: meta.length, totalSamples };
}
