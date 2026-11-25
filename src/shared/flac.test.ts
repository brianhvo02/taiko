import { describe, expect, it } from 'vitest';
import { findFrame, flacStartAt, parseFrameHeader, readFlacIndex, streamHeader } from './flac';
import type { Reader } from './flac';

const BLOCK = 4096;
const RATE = 44100;

function crc8(bytes: number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

/** A number in FLAC's UTF-8-like coding. */
function coded(value: number): number[] {
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
}

// A small deterministic generator, so the made-up audio data is the same on every run.
function noise(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state >>> 24;
  };
}

interface Made {
  bytes: Uint8Array;
  /** Where each frame starts. */
  offsets: number[];
  audioStart: number;
  read: Reader;
  reads: number[];
}

/** A FLAC file of `frames` stereo 16-bit frames of 4096 samples with made-up contents, optionally with a seek table. */
function makeFlac(frames: number, options: { seekEvery?: number; lastBlock?: number; id3?: boolean; variable?: boolean } = {}): Made {
  const random = noise(7);
  const lastBlock = options.lastBlock ?? BLOCK;
  const total = (frames - 1) * BLOCK + lastBlock;
  const frameBytes: number[][] = [];
  for (let n = 0; n < frames; n++) {
    const last = n === frames - 1 && lastBlock !== BLOCK;
    // sync, then block size code (12 = 4096, or 7 = given as 16 bits) and rate code 9 (44.1 kHz), then stereo, 16 bits
    const head = [0xff, options.variable ? 0xf9 : 0xf8, ((last ? 7 : 12) << 4) | 9, (1 << 4) | (4 << 1), ...coded(options.variable ? n * BLOCK : n)];
    if (last) head.push((lastBlock - 1) >> 8, (lastBlock - 1) & 0xff);
    head.push(crc8(head));
    const length = 600 + (random() * 9) + random();
    // No 0xFF in the data, so only real headers carry a sync code; one test below adds a false one on purpose.
    const data = Array.from({ length }, () => Math.min(random(), 0xfe));
    frameBytes.push([...head, ...data]);
  }

  const info = new Uint8Array(34);
  info.set([BLOCK >> 8, BLOCK & 0xff, BLOCK >> 8, BLOCK & 0xff]);
  info[10] = RATE >> 12; info[11] = (RATE >> 4) & 0xff; info[12] = ((RATE & 0x0f) << 4) | (1 << 1); // 2 channels
  info[13] = (15 << 4) | Math.floor(total / 2 ** 32); // 16 bits per sample
  info[14] = (total >>> 24) & 0xff; info[15] = (total >>> 16) & 0xff; info[16] = (total >>> 8) & 0xff; info[17] = total & 0xff;
  info.fill(0xab, 18); // a checksum that streamHeader must clear

  const starts: number[] = [];
  let at = 0;
  for (const frame of frameBytes) { starts.push(at); at += frame.length; }

  const table: number[] = [];
  if (options.seekEvery) {
    for (let n = 0; n < frames; n += options.seekEvery) {
      const sample = n * BLOCK;
      table.push(0, 0, 0, 0, (sample >>> 24) & 0xff, (sample >>> 16) & 0xff, (sample >>> 8) & 0xff, sample & 0xff);
      table.push(0, 0, 0, 0, (starts[n] >>> 24) & 0xff, (starts[n] >>> 16) & 0xff, (starts[n] >>> 8) & 0xff, starts[n] & 0xff);
      table.push(BLOCK >> 8, BLOCK & 0xff);
    }
    table.push(...Array.from({ length: 18 }, (_, i) => (i < 8 ? 0xff : 0))); // a placeholder point
  }
  const comment = [4, 0, 0, 0, 0x74, 0x65, 0x73, 0x74, 0, 0, 0, 0];
  const prefix = options.id3 ? [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5] : [];
  const meta = [
    ...prefix, 0x66, 0x4c, 0x61, 0x43,
    0x00, 0, 0, 34, ...info,
    ...(table.length ? [0x03, (table.length >> 16) & 0xff, (table.length >> 8) & 0xff, table.length & 0xff, ...table] : []),
    0x84, 0, 0, comment.length, ...comment,
  ];
  const bytes = Uint8Array.from([...meta, ...frameBytes.flat()]);
  const reads: number[] = [];
  const read: Reader = async (offset, length) => {
    reads.push(length);
    return bytes.subarray(offset, offset + length);
  };
  return { bytes, offsets: starts.map((start) => meta.length + start), audioStart: meta.length, read, reads };
}

describe('readFlacIndex', () => {
  it('reads the stream details, where the audio starts and the seek table', async () => {
    const file = makeFlac(200, { seekEvery: 50 });
    const index = await readFlacIndex(file.read, file.bytes.length);
    expect(index).toMatchObject({ sampleRate: RATE, channels: 2, bitsPerSample: 16, maxBlock: BLOCK, totalSamples: 200 * BLOCK, audioStart: file.audioStart });
    expect(index?.seekPoints).toEqual([0, 50, 100, 150].map((n) => ({ sample: n * BLOCK, offset: file.offsets[n] })));
  });

  it('skips an ID3 tag in front of the stream', async () => {
    const file = makeFlac(20, { id3: true });
    expect((await readFlacIndex(file.read, file.bytes.length))?.audioStart).toBe(file.audioStart);
  });

  it('says no to anything that is not FLAC', async () => {
    const bytes = new TextEncoder().encode('OggS and then some more bytes');
    expect(await readFlacIndex(async (offset, length) => bytes.subarray(offset, offset + length), bytes.length)).toBeNull();
    expect(await readFlacIndex(async () => new Uint8Array(0), 0)).toBeNull();
  });
});

describe('findFrame', () => {
  for (const [name, options] of [['with no seek table', {}], ['with a seek table', { seekEvery: 100 }], ['with variable block sizes', { variable: true }]] as const) {
    it(`finds the frame holding any sample, ${name}`, async () => {
      const file = makeFlac(3000, options);
      const index = (await readFlacIndex(file.read, file.bytes.length))!;
      for (const frame of [0, 1, 2, 17, 500, 1499, 1500, 2998, 2999]) {
        for (const within of [0, 1, BLOCK - 1]) {
          const found = await findFrame(file.read, index, frame * BLOCK + within);
          expect(found, `frame ${frame} + ${within}`).toMatchObject({ offset: file.offsets[frame], sample: frame * BLOCK });
        }
      }
    });
  }

  it('reads a little of the file, not all of it', async () => {
    const file = makeFlac(6000);
    const index = (await readFlacIndex(file.read, file.bytes.length))!;
    file.reads.length = 0;
    await findFrame(file.read, index, 4321 * BLOCK);
    expect(file.reads.reduce((sum, n) => sum + n, 0)).toBeLessThan(file.bytes.length / 4);
    expect(file.reads.length).toBeLessThanOrEqual(4);
  });

  it('clamps times before the start and after the end', async () => {
    const file = makeFlac(400, { lastBlock: 1000 });
    const index = (await readFlacIndex(file.read, file.bytes.length))!;
    expect(await findFrame(file.read, index, -5)).toMatchObject({ offset: file.audioStart, sample: 0 });
    expect(await findFrame(file.read, index, 10 ** 9)).toMatchObject({ offset: file.offsets[399], sample: 399 * BLOCK, blockSize: 1000 });
  });

  it('is not fooled by audio data that looks like a frame header', async () => {
    const file = makeFlac(300);
    const index = (await readFlacIndex(file.read, file.bytes.length))!;
    // A header-shaped run with a valid checksum but a frame number that fits nowhere, inside frame 150's data.
    const fake = [0xff, 0xf8, (12 << 4) | 9, (1 << 4) | (4 << 1), ...coded(9000)];
    fake.push(crc8(fake));
    file.bytes.set(fake, file.offsets[150] + 40);
    expect(parseFrameHeader(file.bytes, file.offsets[150] + 40, index)).not.toBeNull();
    expect(await findFrame(file.read, index, 150 * BLOCK + 2000)).toMatchObject({ offset: file.offsets[150], sample: 150 * BLOCK });
  });
});

describe('streamHeader and flacStartAt', () => {
  it('describes the rest of the song from the frame it starts at', async () => {
    const file = makeFlac(1000);
    const index = (await readFlacIndex(file.read, file.bytes.length))!;
    const start = await flacStartAt(file.read, index, 60);
    const frame = Math.floor((60 * RATE) / BLOCK);
    expect(start).toEqual({ offset: file.offsets[frame], startSample: frame * BLOCK, startSeconds: (frame * BLOCK) / RATE, totalSeconds: (1000 * BLOCK) / RATE });
    expect(start.startSeconds).toBeLessThanOrEqual(60);
    expect(60 - start.startSeconds).toBeLessThan(BLOCK / RATE);

    // The new stream is itself a FLAC file: its index says what remains, and its first frame is at once after the header.
    const header = streamHeader(index, start.startSample);
    const stream = new Uint8Array(header.length + file.bytes.length - start.offset);
    stream.set(header);
    stream.set(file.bytes.subarray(start.offset), header.length);
    const again = (await readFlacIndex(async (offset, length) => stream.subarray(offset, offset + length), stream.length))!;
    expect(again).toMatchObject({ audioStart: 42, totalSamples: (1000 - frame) * BLOCK, sampleRate: RATE, channels: 2, bitsPerSample: 16 });
    expect([...header.subarray(26)]).toEqual(new Array(16).fill(0));
    expect(parseFrameHeader(stream, 42, again)).toEqual({ sample: frame * BLOCK, blockSize: BLOCK });
  });
});
