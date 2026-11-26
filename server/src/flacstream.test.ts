import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFlacIndex, streamHeader, flacStartAt } from '../../src/shared/flac';
import { FlacStreamParser } from '../../src/shared/flacstream';
import type { FlacPiece } from '../../src/shared/flacstream';

/** Made-up audio encoded by a real encoder: a 3 s stereo tone at 16 bits, and 1.5 s of mono noise at 24 bits. */
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(__dirname, 'fixtures', name)));
const reader = (file: Uint8Array) => async (offset: number, length: number) => file.subarray(offset, offset + length);

/** Feeds a stream to a parser in pieces of uneven size, as a network would. */
function cut(stream: Uint8Array, pieceSeconds: number, sizes = [1, 7, 4096, 13, 30000, 222]): { pieces: FlacPiece[]; parser: FlacStreamParser } {
  const parser = new FlacStreamParser(pieceSeconds);
  const pieces: FlacPiece[] = [];
  for (let at = 0, turn = 0; at < stream.length; turn++) {
    const size = sizes[turn % sizes.length];
    pieces.push(...parser.push(stream.subarray(at, at + size)));
    at += size;
  }
  pieces.push(...parser.end());
  return { pieces, parser };
}

const framesOf = (piece: FlacPiece): Uint8Array => piece.bytes.subarray(42);
const joined = (pieces: FlacPiece[]): Uint8Array => {
  const out = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.bytes.length - 42, 0));
  let at = 0;
  for (const piece of pieces) { out.set(framesOf(piece), at); at += piece.bytes.length - 42; }
  return out;
};

describe('FlacStreamParser', () => {
  for (const [name, rate, channels, bits, samples] of [['tone-16.flac', 44100, 2, 16, 132300], ['noise-24.flac', 16000, 1, 24, 24000]] as const) {
    it(`cuts ${name} into pieces of whole frames that follow each other exactly`, async () => {
      const file = fixture(name);
      const index = (await readFlacIndex(reader(file), file.length))!;
      const { pieces, parser } = cut(file, 0.5);
      expect(parser.info).toEqual({ sampleRate: rate, channels, bitsPerSample: bits, totalSamples: samples });
      expect(pieces.length).toBeGreaterThan(2);
      // Every sample is in one piece, in order, and each piece but the last holds about half a second.
      expect(pieces.reduce((sum, piece) => sum + piece.samples, 0)).toBe(samples);
      let next = 0;
      for (const piece of pieces) {
        expect(piece.startSample).toBe(next);
        next += piece.samples;
      }
      for (const piece of pieces.slice(0, -1)) {
        expect(piece.samples).toBeGreaterThanOrEqual(rate * 0.5);
        expect(piece.samples).toBeLessThan(rate * 0.5 + index.maxBlock);
      }
      // The pieces' frames, end to end, are the file's audio, byte for byte.
      expect(Buffer.from(joined(pieces)).equals(Buffer.from(file.subarray(index.audioStart)))).toBe(true);
      // Each piece is a FLAC file of its own: the marker, one block saying how long it is, then a frame.
      for (const piece of pieces) {
        const again = cut(piece.bytes, 100);
        expect(again.parser.info).toEqual({ sampleRate: rate, channels, bitsPerSample: bits, totalSamples: piece.samples });
        expect(again.pieces).toHaveLength(1);
        expect(again.pieces[0].samples).toBe(piece.samples);
        expect(again.pieces[0].startSample).toBe(piece.startSample);
      }
    });
  }

  it('reads a stream that begins part-way through the song, as an exact seek plays', async () => {
    const file = fixture('tone-16.flac');
    const index = (await readFlacIndex(reader(file), file.length))!;
    const start = await flacStartAt(reader(file), index, 1.7);
    const stream = new Uint8Array([...streamHeader(index, start.startSample), ...file.subarray(start.offset)]);
    const { pieces, parser } = cut(stream, 0.25);
    expect(parser.info?.totalSamples).toBe(132300 - start.startSample);
    // The frames keep the sample numbers they have in the whole song.
    expect(pieces[0].startSample).toBe(start.startSample);
    expect(pieces.reduce((sum, piece) => sum + piece.samples, 0)).toBe(132300 - start.startSample);
  });

  it('skips an ID3 tag and other blocks before the audio, and refuses what is not FLAC', () => {
    const file = fixture('noise-24.flac');
    const tagged = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20, ...new Uint8Array(20), ...file]);
    expect(cut(tagged, 10).pieces.reduce((sum, piece) => sum + piece.samples, 0)).toBe(24000);
    expect(() => cut(new TextEncoder().encode('this is not a FLAC stream at all'), 1)).toThrow('not FLAC');
    // Nothing comes of a stream that stops before its audio.
    expect(cut(file.subarray(0, 30), 1).pieces).toEqual([]);
  });
});
