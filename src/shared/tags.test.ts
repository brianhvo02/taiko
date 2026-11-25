import { describe, expect, it } from 'vitest';
import { lyricsBelongTo } from './api';
import { readTags, readTagsFrom } from './tags';

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
    expect(readTags(flac(['ALBUMARTIST=Midori Vale', 'ALBUMARTISTSORT=Vale Midori', 'DATE=2026-10-14']))).toMatchObject({ albumArtist: 'Midori Vale', albumArtistRoman: 'Vale Midori', date: '2026-10-14' });
    const tags = readTags(flac(['title=Paper Lanterns', 'ARTIST=Midori Vale', 'Album=Night Market', 'TRACKNUMBER=3/12', 'DISCNUMBER=1']));
    expect(tags).toEqual({ title: 'Paper Lanterns', artist: 'Midori Vale', album: 'Night Market', trackNumber: 3, discNumber: 1, durationSeconds: 10, sampleRate: 44100, bitsPerSample: 16 });
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

describe('readTagsFrom', () => {
  const reader = (file: Uint8Array, reads: number[] = []) => async (offset: number, length: number) => {
    reads.push(length);
    return file.subarray(offset, offset + length);
  };

  it('finds FLAC tags behind a cover picture of any size, without reading the picture', async () => {
    const plain = flac(['TITLE=紙の灯籠', 'ARTIST=Midori Vale', 'TRACKNUMBER=2']);
    // The same file with a 3 MB picture block between the stream details and the comments.
    const picture = new Uint8Array(3 * 1024 * 1024).fill(0x55);
    const withCover = bytes(plain.subarray(0, 42), [6, ...be24(picture.length)], picture, plain.subarray(42));
    expect(readTags(withCover.subarray(0, 256 * 1024)).title).toBe(''); // the old way misses them

    const reads: number[] = [];
    expect(await readTagsFrom(reader(withCover, reads), withCover.length)).toEqual({
      title: '紙の灯籠', artist: 'Midori Vale', album: '', trackNumber: 2, discNumber: null, durationSeconds: 10, sampleRate: 44100, bitsPerSample: 16,
    });
    expect(reads.reduce((sum, n) => sum + n, 0)).toBeLessThan(1024);
  });

  it('reads an MP4 file\'s iTunes items and length, with the movie atom after the audio and a cover among the items', async () => {
    const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    const atom = (type: string | number[], ...body: (number[] | Uint8Array | string)[]) => {
      const inner = bytes(...body);
      return bytes(be32(inner.length + 8), typeof type === 'string' ? type : type, inner);
    };
    const text = (type: number[] | string, value: string) => atom(type, atom('data', be32(1), be32(0), value));
    const free = (name: string, value: string) => atom('----', atom('mean', be32(0), 'com.apple.iTunes'), atom('name', be32(0), name), atom('data', be32(1), be32(0), value));
    const c = (rest: string) => [0xa9, ...[...rest].map((ch) => ch.charCodeAt(0))];
    const items = atom('ilst',
      atom('covr', atom('data', be32(13), be32(0), new Uint8Array(2 * 1024 * 1024).fill(0x55))),
      text(c('nam'), '紙の灯籠'), text(c('ART'), 'Midori Vale'), text(c('alb'), 'Night Market'), text('aART', 'Various'), text(c('day'), '2026-03-01'),
      atom('trkn', atom('data', be32(0), be32(0), [0, 0, 0, 2, 0, 9, 0, 0])), atom('disk', atom('data', be32(0), be32(0), [0, 0, 0, 1, 0, 1])),
      text('sonm', 'Kami no Tourou'), free('TITLE_EN', 'Paper Lanterns'), free('APPLE_SONG_ID', '9900112233'), free('SOMETHING_ELSE', 'ignored'));
    // Timescale 44100, 441000 units: ten seconds.
    const mvhd = atom('mvhd', be32(0), be32(0), be32(0), be32(44100), be32(441000), new Uint8Array(80));
    const moov = atom('moov', mvhd, atom('trak', new Uint8Array(64)), atom('udta', atom('meta', be32(0), atom('hdlr', new Uint8Array(25)), items)));
    const file = bytes(atom('ftyp', 'M4A ', be32(0), 'M4A mp42isom'), atom('mdat', new Uint8Array(1024 * 1024)), moov);

    const reads: number[] = [];
    expect(await readTagsFrom(reader(file, reads), file.length)).toEqual({
      title: '紙の灯籠', artist: 'Midori Vale', album: 'Night Market', trackNumber: 2, discNumber: 1, durationSeconds: 10,
      albumArtist: 'Various', date: '2026-03-01', titleRoman: 'Kami no Tourou', titleEnglish: 'Paper Lanterns', appleSongId: '9900112233',
    });
    // Neither the audio nor the cover was read.
    expect(reads.reduce((sum, n) => sum + n, 0)).toBeLessThan(4096);
    // A file cut short gives what it can, not an error.
    expect((await readTagsFrom(reader(file.subarray(0, file.length - 200)), file.length - 200)).title).toBe('');
  });

  it('reads other formats from their start, and gives empty tags for anything unreadable', async () => {
    const utf16 = (text: string) => [0x01, 0xff, 0xfe, ...[...text].flatMap((ch) => [ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8])];
    const frame = bytes('TIT2', [0, 0, 0, utf16('灯籠').length, 0, 0], utf16('灯籠'));
    const mp3 = bytes('ID3', [3, 0, 0, 0, 0, 0, frame.length], frame, [0xff, 0xfb, 0x90, 0x00]);
    expect((await readTagsFrom(reader(mp3), mp3.length)).title).toBe('灯籠');

    const none = { title: '', artist: '', album: '', trackNumber: null, discNumber: null, durationSeconds: null };
    expect(await readTagsFrom(reader(bytes('OggS', [0, 0, 0])), 7)).toEqual(none);
    expect(await readTagsFrom(reader(new Uint8Array(0)), 0)).toEqual(none);
    expect(await readTagsFrom(async () => { throw new Error('gone'); }, 100)).toEqual(none);
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
