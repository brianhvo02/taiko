/**
 * Cuts a FLAC stream, as its bytes arrive, into pieces that are each a small FLAC file of whole frames. A browser
 * decodes such a piece exactly (FLAC has no padding and its frames stand alone), so pieces decoded one by one and
 * played back to back are the song, sample for sample: that is how the player joins one song to the next without
 * a gap (player/engine.ts). The stream may be a whole file, or one that begins at a frame (what an exact seek
 * plays; see flac.ts), whose frames still carry their sample numbers in the whole song.
 *
 * Frames are found by their headers, and a header is believed only when it checks out (flac.ts) and starts at
 * exactly the sample the frame before it ends on, so audio that happens to look like a header is never taken for one.
 */
import { parseFrameHeader } from './flac';
import type { FlacIndex } from './flac';

/** What the stream says about its audio. */
export interface FlacStreamInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Samples in the stream from its start to its end; 0 when it doesn't say. */
  totalSamples: number;
}

/** A run of whole frames as a FLAC file of its own. */
export interface FlacPiece {
  bytes: Uint8Array<ArrayBuffer>;
  /** How many samples (per channel) it holds, and the sample of the song it starts at. */
  samples: number;
  startSample: number;
}

const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const be32 = (b: Uint8Array, at: number) => b[at] * 2 ** 24 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);

/** A frame can't be shorter than this many bytes; the search for the next one starts that far on. */
const MIN_FRAME_BYTES = 8;

export class FlacStreamParser {
  info: FlacStreamInfo | null = null;
  private buffer = new Uint8Array(0);
  private index: FlacIndex | null = null;
  /** Bytes still to skip before the frames: an ID3 tag in front, or metadata blocks. */
  private skip = 0;
  private phase: 'start' | 'blocks' | 'frames' = 'start';
  /** The frames gathered for the piece being made: where the first starts in `buffer`, and the samples so far. */
  private pieceSamples = 0;
  private pieceStart = -1;
  private pieceFirst = 0;
  /** The frame being measured: where it starts in `buffer`, its first sample and its length in samples. */
  private frameAt = -1;
  private frameSample = 0;
  private frameBlock = 0;
  /** Where the search for the next header has got to. */
  private scan = 0;

  /** `pieceSeconds` is about how much audio goes in a piece. */
  constructor(private readonly pieceSeconds = 2) {}

  private append(bytes: Uint8Array): void {
    const joined = new Uint8Array(this.buffer.length + bytes.length);
    joined.set(this.buffer);
    joined.set(bytes, this.buffer.length);
    this.buffer = joined;
  }

  private drop(count: number): void {
    this.buffer = this.buffer.subarray(count);
    this.scan = Math.max(0, this.scan - count);
    if (this.frameAt >= 0) this.frameAt -= count;
    if (this.pieceStart >= 0) this.pieceStart -= count;
  }

  /** Takes in more of the stream; gives the pieces that are now complete. Throws when the stream isn't FLAC. */
  push(bytes: Uint8Array): FlacPiece[] {
    this.append(bytes);
    if (!this.readHead()) return [];
    return this.takePieces(false);
  }

  /** The stream is over: gives what is left as a last piece. */
  end(): FlacPiece[] {
    return this.phase === 'frames' ? this.takePieces(true) : [];
  }

  /** Works through what comes before the frames. True once the frames are reached. */
  private readHead(): boolean {
    for (;;) {
      if (this.skip > 0) {
        const gone = Math.min(this.skip, this.buffer.length);
        this.drop(gone);
        this.skip -= gone;
        if (this.skip > 0) return false;
      }
      if (this.phase === 'frames') return true;
      if (this.phase === 'start') {
        if (this.buffer.length < 10) return false;
        if (this.buffer[0] === 0x49 && this.buffer[1] === 0x44 && this.buffer[2] === 0x33) {
          // An ID3 tag in front of the FLAC marker: its length is four 7-bit bytes.
          this.skip = 10 + (((this.buffer[6] & 0x7f) << 21) | ((this.buffer[7] & 0x7f) << 14) | ((this.buffer[8] & 0x7f) << 7) | (this.buffer[9] & 0x7f));
          continue;
        }
        if (this.buffer[0] !== 0x66 || this.buffer[1] !== 0x4c || this.buffer[2] !== 0x61 || this.buffer[3] !== 0x43) throw new Error('not FLAC');
        this.drop(4);
        this.phase = 'blocks';
        continue;
      }
      // A metadata block: a byte of type (the top bit marks the last one) and three of length.
      if (this.buffer.length < 4) return false;
      const type = this.buffer[0] & 0x7f;
      const last = (this.buffer[0] & 0x80) !== 0;
      const length = (this.buffer[1] << 16) | (this.buffer[2] << 8) | this.buffer[3];
      if (type === 0) {
        if (this.buffer.length < 4 + 34) return false;
        const info = this.buffer.slice(4, 38);
        const sampleRate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
        const channels = ((info[12] >> 1) & 7) + 1;
        const bitsPerSample = (((info[12] & 1) << 4) | (info[13] >> 4)) + 1;
        const totalSamples = (info[13] & 0x0f) * 2 ** 32 + be32(info, 14);
        if (!sampleRate) throw new Error('not FLAC');
        this.info = { sampleRate, channels, bitsPerSample, totalSamples };
        this.index = { size: 0, audioStart: 0, sampleRate, channels, bitsPerSample, maxBlock: be16(info, 2), totalSamples: totalSamples || Number.MAX_SAFE_INTEGER, streamInfo: info, seekPoints: [] };
      }
      this.skip = 4 + length;
      if (last) {
        if (!this.index) throw new Error('not FLAC');
        this.phase = 'frames';
      }
    }
  }

  private takePieces(atEnd: boolean): FlacPiece[] {
    const index = this.index!;
    const pieces: FlacPiece[] = [];
    const target = index.sampleRate * this.pieceSeconds;

    if (this.frameAt < 0) {
      // The stream's first frame is where the head ended.
      const first = parseFrameHeader(this.buffer, 0, index);
      if (!first) {
        if (this.buffer.length < 17 && !atEnd) return pieces;
        throw new Error('no FLAC frame where the audio should start');
      }
      this.frameAt = 0;
      this.frameSample = first.sample;
      this.frameBlock = first.blockSize;
      this.pieceStart = 0;
      this.pieceFirst = first.sample;
      this.pieceSamples = 0;
      this.scan = MIN_FRAME_BYTES;
    }

    for (;;) {
      // The next frame starts at the first header that checks out and begins on the sample this one ends on.
      let next = -1;
      let header: { sample: number; blockSize: number } | null = null;
      for (let at = Math.max(this.scan, this.frameAt + MIN_FRAME_BYTES); at + 17 <= this.buffer.length; at++) {
        if (this.buffer[at] !== 0xff || (this.buffer[at + 1] & 0xfe) !== 0xf8) continue;
        header = parseFrameHeader(this.buffer, at, index);
        if (header && header.sample === this.frameSample + this.frameBlock) {
          next = at;
          break;
        }
      }
      if (next < 0 || !header) {
        // Not here yet. What has been looked through needn't be looked through again.
        this.scan = Math.max(this.scan, this.buffer.length - 16);
        break;
      }
      // The frame before is whole, and joins the piece. A piece with enough in it is cut here.
      this.pieceSamples += this.frameBlock;
      if (this.pieceSamples >= target) {
        pieces.push(this.piece(this.buffer.subarray(this.pieceStart, next), this.pieceSamples, this.pieceFirst));
        this.drop(next);
        next = 0;
        this.pieceStart = 0;
        this.pieceFirst = header.sample;
        this.pieceSamples = 0;
      }
      this.frameAt = next;
      this.frameSample = header.sample;
      this.frameBlock = header.blockSize;
      this.scan = next + MIN_FRAME_BYTES;
    }

    if (atEnd && this.frameAt >= 0) {
      // The last frame runs to the end of the stream.
      this.pieceSamples += this.frameBlock;
      pieces.push(this.piece(this.buffer.subarray(this.pieceStart), this.pieceSamples, this.pieceFirst));
      this.buffer = new Uint8Array(0);
      this.frameAt = -1;
      this.phase = 'start';
    }
    return pieces;
  }

  /** A FLAC file of its own from a run of frames: the marker, the stream's details with this piece's length, the frames. */
  private piece(frames: Uint8Array, samples: number, startSample: number): FlacPiece {
    const bytes = new Uint8Array(42 + frames.length);
    bytes.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22]);
    const info = Uint8Array.from(this.index!.streamInfo.subarray(0, 34));
    info[13] = (info[13] & 0xf0) | (Math.floor(samples / 2 ** 32) & 0x0f);
    info[14] = (samples >>> 24) & 0xff;
    info[15] = (samples >>> 16) & 0xff;
    info[16] = (samples >>> 8) & 0xff;
    info[17] = samples & 0xff;
    // The checksum was of the whole song's audio.
    info.fill(0, 18);
    bytes.set(info, 8);
    bytes.set(frames, 42);
    return { bytes, samples, startSample };
  }
}
