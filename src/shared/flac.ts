/**
 * Exact seeking in FLAC files, for browsers that seek them only roughly (Safari jumps to an estimated spot and then
 * reports the time that was asked for). Instead of asking the browser to seek, Taiko plays a new stream that begins
 * exactly at a frame: a small FLAC header followed by the file's bytes from that frame on. A stream played from its
 * start is always in time, and the frame's own header says which sample it starts at.
 *
 * Used by the player (files on the device) and by the NAS server (streamed files), so it touches neither the DOM
 * nor Node: callers hand it a `Reader` over the file.
 */

/** Reads `length` bytes at `offset`; fewer at the end of the file. */
export type Reader = (offset: number, length: number) => Promise<Uint8Array>;

export interface FlacIndex {
  /** The file's size in bytes. */
  size: number;
  /** Where the first audio frame starts. */
  audioStart: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  maxBlock: number;
  totalSamples: number;
  /** The STREAMINFO block's 34 bytes. */
  streamInfo: Uint8Array;
  /** The file's own seek table, with absolute byte offsets. Often coarse (every 10 seconds) or missing. */
  seekPoints: { sample: number; offset: number }[];
}

/** An audio frame: where it starts in the file and the sample it starts at. */
export interface FlacFrame {
  offset: number;
  sample: number;
  blockSize: number;
}

const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const be24 = (b: Uint8Array, at: number) => (b[at] << 16) | (b[at + 1] << 8) | b[at + 2];
const be32 = (b: Uint8Array, at: number) => b[at] * 2 ** 24 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
const be64 = (b: Uint8Array, at: number) => be32(b, at) * 2 ** 32 + be32(b, at + 4);

/** Walks the metadata blocks at the start of a FLAC file. Null when the file isn't FLAC or doesn't say how long it is. */
export async function readFlacIndex(read: Reader, size: number): Promise<FlacIndex | null> {
  let at = 0;
  const start = await read(0, 10);
  if (start.length >= 10 && start[0] === 0x49 && start[1] === 0x44 && start[2] === 0x33) {
    // An ID3v2 tag in front of the stream: ten bytes, a syncsafe size, and ten more when it has a footer.
    at = 10 + (((start[6] & 0x7f) << 21) | ((start[7] & 0x7f) << 14) | ((start[8] & 0x7f) << 7) | (start[9] & 0x7f)) + (start[5] & 0x10 ? 10 : 0);
  }
  const magic = await read(at, 4);
  if (magic.length < 4 || magic[0] !== 0x66 || magic[1] !== 0x4c || magic[2] !== 0x61 || magic[3] !== 0x43) return null;
  at += 4;

  let streamInfo: Uint8Array | null = null;
  const rawPoints: { sample: number; offset: number }[] = [];
  for (let blocks = 0; blocks < 1024; blocks++) {
    const header = await read(at, 4);
    if (header.length < 4) return null;
    const type = header[0] & 0x7f;
    const length = be24(header, 1);
    const body = at + 4;
    if (type === 0 && length >= 34) {
      streamInfo = await read(body, 34);
      if (streamInfo.length < 34) return null;
    } else if (type === 3 && length <= 18 * 20000) {
      const table = await read(body, length);
      for (let p = 0; p + 18 <= table.length; p += 18) {
        // A placeholder point is all ones.
        if (be32(table, p) === 0xffffffff && be32(table, p + 4) === 0xffffffff) continue;
        rawPoints.push({ sample: be64(table, p), offset: be64(table, p + 8) });
      }
    }
    at = body + length;
    if (header[0] & 0x80) break;
    if (at >= size) return null;
  }
  if (!streamInfo) return null;

  const sampleRate = (streamInfo[10] << 12) | (streamInfo[11] << 4) | (streamInfo[12] >> 4);
  const totalSamples = (streamInfo[13] & 0x0f) * 2 ** 32 + be32(streamInfo, 14);
  if (sampleRate <= 0 || totalSamples <= 0 || at >= size) return null;
  return {
    size,
    audioStart: at,
    sampleRate,
    channels: ((streamInfo[12] >> 1) & 7) + 1,
    bitsPerSample: (((streamInfo[12] & 1) << 4) | (streamInfo[13] >> 4)) + 1,
    maxBlock: be16(streamInfo, 2),
    totalSamples,
    streamInfo,
    seekPoints: rawPoints
      .map((point) => ({ sample: point.sample, offset: at + point.offset }))
      .filter((point) => point.sample < totalSamples && point.offset < size)
      .sort((a, b) => a.sample - b.sample),
  };
}

function crc8(bytes: Uint8Array, from: number, to: number): number {
  let crc = 0;
  for (let i = from; i < to; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

const SAMPLE_SIZES = [0, 8, 12, -1, 16, 20, 24, 32];

/**
 * Reads a frame header at `at`, or null when the bytes there aren't one: the sync code, the reserved bits, the
 * header's own checksum and its agreement with the stream's channels and sample size are all checked.
 */
export function parseFrameHeader(bytes: Uint8Array, at: number, index: FlacIndex): { sample: number; blockSize: number } | null {
  if (at + 17 > bytes.length) return null;
  if (bytes[at] !== 0xff || (bytes[at + 1] & 0xfe) !== 0xf8) return null;
  const variable = (bytes[at + 1] & 1) === 1;
  const blockCode = bytes[at + 2] >> 4;
  const rateCode = bytes[at + 2] & 0x0f;
  const channelCode = bytes[at + 3] >> 4;
  const sizeCode = (bytes[at + 3] >> 1) & 7;
  if (blockCode === 0 || rateCode === 15 || channelCode > 10 || bytes[at + 3] & 1) return null;
  if ((channelCode < 8 ? channelCode + 1 : 2) !== index.channels) return null;
  if (SAMPLE_SIZES[sizeCode] < 0 || (sizeCode !== 0 && SAMPLE_SIZES[sizeCode] !== index.bitsPerSample)) return null;

  // The frame number (fixed block size) or the sample number (variable), coded like UTF-8 but up to seven bytes.
  let p = at + 4;
  const first = bytes[p];
  let extra: number;
  let value: number;
  if (first < 0x80) { extra = 0; value = first; }
  else if (first < 0xc0) return null;
  else if (first < 0xe0) { extra = 1; value = first & 0x1f; }
  else if (first < 0xf0) { extra = 2; value = first & 0x0f; }
  else if (first < 0xf8) { extra = 3; value = first & 0x07; }
  else if (first < 0xfc) { extra = 4; value = first & 0x03; }
  else if (first < 0xfe) { extra = 5; value = first & 0x01; }
  else if (first === 0xfe && variable) { extra = 6; value = 0; }
  else return null;
  p += 1;
  for (let i = 0; i < extra; i++, p++) {
    if ((bytes[p] & 0xc0) !== 0x80) return null;
    value = value * 64 + (bytes[p] & 0x3f);
  }

  let blockSize: number;
  if (blockCode === 1) blockSize = 192;
  else if (blockCode <= 5) blockSize = 576 << (blockCode - 2);
  else if (blockCode === 6) { blockSize = bytes[p] + 1; p += 1; }
  else if (blockCode === 7) { blockSize = be16(bytes, p) + 1; p += 2; }
  else blockSize = 256 << (blockCode - 8);
  if (rateCode === 12) p += 1;
  else if (rateCode === 13 || rateCode === 14) p += 2;
  if (crc8(bytes, at, p) !== bytes[p]) return null;

  return { sample: variable ? value : value * index.maxBlock, blockSize };
}

/**
 * The frames that start inside `bytes` (which begins at `base` in the file). A frame is kept only when the next
 * one starts exactly where it ends in samples, so a stretch of audio data that happens to look like a header is
 * thrown out; the last frame of the file needs no successor.
 */
function framesIn(bytes: Uint8Array, base: number, index: FlacIndex): FlacFrame[] {
  const found: FlacFrame[] = [];
  for (let i = 0; i + 17 <= bytes.length; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xfe) !== 0xf8) continue;
    const header = parseFrameHeader(bytes, i, index);
    if (header && header.sample < index.totalSamples) found.push({ offset: base + i, ...header });
  }
  return found.filter((frame, i) => {
    if (frame.sample + frame.blockSize >= index.totalSamples) return true;
    for (let j = i + 1; j < found.length; j++) if (found[j].sample === frame.sample + frame.blockSize) return true;
    return false;
  });
}

/**
 * Finds the frame that holds `targetSample`: an interpolation search over the file, starting from the seek table
 * when there is one, reading a window at a time and trusting only the sample numbers in the frames themselves.
 */
export async function findFrame(read: Reader, index: FlacIndex, targetSample: number): Promise<FlacFrame> {
  const first: FlacFrame = { offset: index.audioStart, sample: 0, blockSize: index.maxBlock };
  const target = Math.max(0, Math.min(Math.floor(targetSample), index.totalSamples - 1));
  if (target < index.maxBlock) return first;

  let low = { sample: 0, offset: index.audioStart };
  let high = { sample: index.totalSamples, offset: index.size };
  for (const point of index.seekPoints) {
    if (point.sample <= target && point.sample >= low.sample) low = point;
    else if (point.sample > target && point.sample < high.sample) high = point;
  }

  let best = first;
  let window = 128 * 1024;
  let lastGuess = -1;
  for (let round = 0; round < 24; round++) {
    const span = high.sample - low.sample;
    const estimate = span > 0 ? low.offset + ((high.offset - low.offset) * (target - low.sample)) / span : low.offset;
    // Back off a quarter of a window, so the frame wanted is more likely inside it than just before it.
    let guess = Math.max(low.offset, Math.min(Math.floor(estimate) - window / 4, high.offset - 1));
    if (guess === lastGuess) {
      if (window >= 4 * 1024 * 1024) break;
      window *= 2;
      guess = Math.max(low.offset, Math.min(Math.floor(estimate) - window / 4, high.offset - 1));
    }
    lastGuess = guess;

    const frames = framesIn(await read(guess, Math.min(window, index.size - guess)), guess, index);
    if (!frames.length) continue; // the next round reads a larger window from the same place
    if (frames[0].sample > target) {
      high = frames[0];
      continue;
    }
    let at = 0;
    while (at + 1 < frames.length && frames[at + 1].sample <= target) at++;
    best = frames[at];
    // Found when the frame holds the target, or when the window shows the frame after it starting beyond the target.
    if (best.sample + best.blockSize > target || at + 1 < frames.length) return best;
    low = best;
  }
  return best;
}

/**
 * The 42-byte header of a stream that begins at `startSample`: the FLAC marker and one STREAMINFO block, with the
 * number of samples reduced to what remains and the audio checksum cleared (it covered the whole file).
 */
export function streamHeader(index: FlacIndex, startSample: number): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(42);
  header.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22]);
  // A copy: on a Node Buffer, slice() would be a view, and the edits below would land in the caller's bytes.
  const info = Uint8Array.from(index.streamInfo.subarray(0, 34));
  const remaining = Math.max(0, index.totalSamples - startSample);
  info[13] = (info[13] & 0xf0) | (Math.floor(remaining / 2 ** 32) & 0x0f);
  const low = remaining % 2 ** 32;
  info[14] = low >>> 24;
  info[15] = (low >>> 16) & 0xff;
  info[16] = (low >>> 8) & 0xff;
  info[17] = low & 0xff;
  info.fill(0, 18);
  header.set(info, 8);
  return header;
}

/** Where to restart a FLAC file so that it plays from `seconds`: the frame, and the exact time it starts at. */
export interface FlacStart {
  /** The file offset the stream's audio begins at; the header from `streamHeader` goes in front. */
  offset: number;
  startSample: number;
  startSeconds: number;
  totalSeconds: number;
}

export async function flacStartAt(read: Reader, index: FlacIndex, seconds: number): Promise<FlacStart> {
  const frame = await findFrame(read, index, seconds * index.sampleRate);
  return {
    offset: frame.offset,
    startSample: frame.sample,
    startSeconds: frame.sample / index.sampleRate,
    totalSeconds: index.totalSamples / index.sampleRate,
  };
}
