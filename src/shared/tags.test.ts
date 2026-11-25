import { describe, expect, it } from 'vitest';
import { lyricsBelongTo } from './api';
import { readTags } from './tags';

const bytes = (...parts: (number[] | Uint8Array | string)[]): Uint8Array => {
  const chunks = parts.map((part) => (typeof part === 'string' ? new TextEncoder().encode(part) : Uint8Array.from(part)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
};
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
const be24 = (n: number) => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

function flac(comments: string[], last = true): Uint8Array {
  // STREAMINFO for 44100 Hz and 441000 samples (10 seconds).
  const info = new Uint8Array(34);
  info[10] = 0x0a; info[11] = 0xc4; info[12] = 0x40 | 0x02; // rate 44100, 2 channels (bits spill into byte 12)
  info[13] = 0xf0; // 16 bits per sample, top 4 bits of the sample count are 0
  info.set([0x00, 0x06, 0xba, 0xa8], 14); // 441000
  const vendor = 'test';
  const body = bytes(le32(vendor.length), vendor, le32(comments.length), ...comments.flatMap((c) => {
    const encoded = new TextEncoder().encode(c);
    return [le32(encoded.length), encoded];
  }));
  return bytes('fLaC', [0x00, ...be24(34)], info, [(last ? 0x80 : 0) | 4, ...be24(body.length)], body);
}

describe('readTags', () => {
  it('reads Vorbis comments and the length from a FLAC file', () => {
    const tags = readTags(flac(['title=Paper Lanterns', 'ARTIST=Midori Vale', 'Album=Night Market', 'TRACKNUMBER=3/12', 'DISCNUMBER=1']));
    expect(tags).toEqual({ title: 'Paper Lanterns', artist: 'Midori Vale', album: 'Night Market', trackNumber: 3, discNumber: 1, durationSeconds: 10 });
  });

  it('reads Japanese text', () => {
    expect(readTags(flac(['TITLE=紙の灯籠'])).title).toBe('紙の灯籠');
  });

  it('reads ID3v2.3 text frames in Latin-1 and UTF-16', () => {
    const utf16 = (text: string) => [0x01, 0xff, 0xfe, ...[...text].flatMap((ch) => [ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8])];
    const frame = (id: string, body: number[]) => bytes(id, [0, 0, 0, body.length, 0, 0], body);
    const frames = bytes(frame('TIT2', utf16('灯籠')), frame('TPE1', [0x00, ...new TextEncoder().encode('Midori Vale')]), frame('TRCK', [0x00, 0x37]));
    const tag = bytes('ID3', [3, 0, 0, 0, 0, 0, frames.length], frames);
    expect(readTags(tag)).toMatchObject({ title: '灯籠', artist: 'Midori Vale', trackNumber: 7 });
  });

  it('gives empty tags for an unknown or cut-short file', () => {
    const none = { title: '', artist: '', album: '', trackNumber: null, discNumber: null, durationSeconds: null };
    expect(readTags(bytes('OggS', [0, 0, 0]))).toEqual(none);
    expect(readTags(flac(['TITLE=x']).subarray(0, 20))).toEqual(none);
    expect(readTags(new Uint8Array(0))).toEqual(none);
  });
});

describe('lyricsBelongTo', () => {
  it('matches the same name and its versions', () => {
    expect(lyricsBelongTo('Song.json', 'Song.flac')).toBe(true);
    expect(lyricsBelongTo('song.ja-Latn.json', 'Song.flac')).toBe(true);
    expect(lyricsBelongTo('Song_en.ttml', 'Song.flac')).toBe(true);
    expect(lyricsBelongTo('Songbird.json', 'Song.flac')).toBe(false);
    expect(lyricsBelongTo('Other.lrc', 'Song.flac')).toBe(false);
  });
});
