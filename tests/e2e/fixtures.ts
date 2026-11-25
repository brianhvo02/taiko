/**
 * Made-up songs and lyrics for the browser tests. Nothing here is real music: the audio is a tone written as an
 * uncompressed FLAC file by the small encoder below, so the tests need no ffmpeg and no files in the repo.
 *
 * The tone's pitch rises steadily (`SWEEP_BASE` + `SWEEP_RATE` × seconds, in Hz), so a test can tell where the audio
 * really is from what it hears, and compare that with the position the player shows.
 */

export const SWEEP_BASE = 200;
export const SWEEP_RATE = 50;

const RATE = 22050;
const BLOCK = 4096;

function crc8(bytes: number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function crc16(bytes: Uint8Array, length: number): number {
  let crc = 0;
  for (let i = 0; i < length; i++) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** A number in FLAC's UTF-8-like coding. */
function coded(value: number): number[] {
  if (value < 0x80) return [value];
  const tail: number[] = [];
  let rest = value;
  let lead = 0xc0;
  let room = 0x20;
  while (rest >= room) {
    tail.unshift(0x80 | (rest % 64));
    rest = Math.floor(rest / 64);
    lead = (lead >> 1) | 0x80;
    room >>= 1;
  }
  tail.unshift(0x80 | (rest % 64));
  return [lead | Math.floor(rest / 64), ...tail];
}

export interface ToneOptions {
  seconds: number;
  title?: string;
  artist?: string;
  album?: string;
  track?: number;
  /** Further tags, as written in the file: 'TITLESORT=Minato no Akari'. */
  tags?: string[];
}

/** A mono 16-bit FLAC file of the rising tone, with the tags given. */
export function toneFlac(options: ToneOptions): Buffer {
  const total = Math.round(options.seconds * RATE);
  const frames: Uint8Array[] = [];
  for (let start = 0, n = 0; start < total; start += BLOCK, n++) {
    const size = Math.min(BLOCK, total - start);
    // sync and fixed block size; block size 4096 (code 12) or given in 16 bits (code 7); 22.05 kHz (code 6);
    // one channel, 16 bits per sample
    const head = [0xff, 0xf8, ((size === BLOCK ? 12 : 7) << 4) | 6, 4 << 1, ...coded(n)];
    if (size !== BLOCK) head.push((size - 1) >> 8, (size - 1) & 0xff);
    head.push(crc8(head));
    const frame = new Uint8Array(head.length + 1 + size * 2 + 2);
    frame.set(head);
    frame[head.length] = 0x02; // one subframe, stored as it is ("verbatim")
    let at = head.length + 1;
    for (let i = 0; i < size; i++, at += 2) {
      const t = (start + i) / RATE;
      const sample = Math.round(0.2 * 32767 * Math.sin(2 * Math.PI * (SWEEP_BASE * t + (SWEEP_RATE / 2) * t * t)));
      frame[at] = (sample >> 8) & 0xff;
      frame[at + 1] = sample & 0xff;
    }
    const check = crc16(frame, at);
    frame[at] = check >> 8;
    frame[at + 1] = check & 0xff;
    frames.push(frame);
  }

  const info = new Uint8Array(34);
  info.set([BLOCK >> 8, BLOCK & 0xff, BLOCK >> 8, BLOCK & 0xff]);
  info[10] = RATE >> 12;
  info[11] = (RATE >> 4) & 0xff;
  info[12] = ((RATE & 0x0f) << 4) | (15 >> 4); // one channel; the top bit of "16 bits per sample"
  info[13] = ((15 & 0x0f) << 4) | Math.floor(total / 2 ** 32);
  info[14] = (total >>> 24) & 0xff;
  info[15] = (total >>> 16) & 0xff;
  info[16] = (total >>> 8) & 0xff;
  info[17] = total & 0xff;

  const comments = [
    options.title && `TITLE=${options.title}`,
    options.artist && `ARTIST=${options.artist}`,
    options.album && `ALBUM=${options.album}`,
    options.track && `TRACKNUMBER=${options.track}`,
    ...(options.tags ?? []),
  ].filter((entry): entry is string => Boolean(entry)).map((entry) => Buffer.from(entry, 'utf8'));
  const le32 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
  const vendor = Buffer.from('taiko tests');
  const vorbis = Buffer.concat([le32(vendor.length), vendor, le32(comments.length), ...comments.flatMap((entry) => [le32(entry.length), entry])]);

  return Buffer.concat([
    Buffer.from('fLaC'),
    Buffer.from([0x00, 0, 0, 34]), info,
    Buffer.from([0x84, (vorbis.length >> 16) & 0xff, (vorbis.length >> 8) & 0xff, vorbis.length & 0xff]), vorbis,
    ...frames,
  ]);
}

/* ---------- Lyrics, in the shape Apple Music serves them ---------- */

const HEAD_OPEN = '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word" xml:lang="ja"><head><metadata><ttm:agent type="person" xml:id="v1"/><iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal">';
const HEAD_CLOSE = '</iTunesMetadata></metadata></head>';
const WRITERS = '<songwriters><songwriter>Midori Vale</songwriter></songwriters>';
const BODY = '<body dur="0:50.000">'
  + '<div begin="2.000" end="10.000" itunes:songPart="Verse">'
  + '<p begin="2.000" end="6.000" itunes:key="L1" ttm:agent="v1"><span begin="2.000" end="4.000">紙の</span><span begin="4.000" end="6.000">灯籠</span></p>'
  + '<p begin="6.000" end="10.000" itunes:key="L2" ttm:agent="v1"><span begin="6.000" end="8.000">夜を</span> <span begin="8.000" end="10.000">渡る</span></p>'
  + '</div><div begin="30.000" end="38.000" itunes:songPart="Chorus">'
  + '<p begin="30.000" end="38.000" itunes:key="L3" ttm:agent="v1"><span begin="30.000" end="34.000">また</span><span begin="34.000" end="38.000">明日</span></p>'
  + '</div></body></tt>';
const span = (begin: string, end: string, text: string) => `<span begin="${begin}" end="${end}" xmlns="http://www.w3.org/ns/ttml">${text}</span>`;
const ROMAN = '<transliterations><transliteration xml:lang="ja-Latn">'
  + `<text for="L1">${span('2.000', '4.000', 'kami no')} ${span('4.000', '6.000', 'tourou')}</text>`
  + `<text for="L2">${span('6.000', '8.000', 'yoru o')} ${span('8.000', '10.000', 'wataru')}</text>`
  + `<text for="L3">${span('30.000', '34.000', 'mata')} ${span('34.000', '38.000', 'ashita')}</text>`
  + '</transliteration></transliterations>';
const ENGLISH = '<translations><translation type="subtitle" xml:lang="en-US"><text for="L1">Paper lanterns</text><text for="L2">Crossing the night</text><text for="L3">See you tomorrow</text></translation></translations>';

/** The made-up song's Apple Music ID, as its lyrics files carry it. */
export const SONG_ID = '9900112233';

const wrap = (ttml: string) => JSON.stringify({ data: [{ id: SONG_ID, type: 'syllable-lyrics', attributes: { playParams: { catalogId: SONG_ID, kind: 'lyric' }, ttmlLocalizations: ttml } }] });

/** Three versions of one song's lyrics: plain, with a romanization, with an English translation. */
export const lyrics = {
  plain: wrap(HEAD_OPEN + '<translations/>' + WRITERS + HEAD_CLOSE + BODY),
  roman: wrap(HEAD_OPEN + '<translations/>' + WRITERS + ROMAN + HEAD_CLOSE + BODY),
  english: wrap(HEAD_OPEN + ENGLISH + WRITERS + HEAD_CLOSE + BODY),
  /** Different words, so a different song. */
  other: wrap((HEAD_OPEN + '<translations/>' + HEAD_CLOSE + BODY).replace('紙の', '石の')),
  /** The same lines as a plain LRC file. */
  lrc: '[00:02.00]Paper lanterns\n[00:06.00]Crossing the night\n[00:30.00]See you tomorrow\n[00:38.00]\n',
};

/** What Apple's catalog says about the made-up song, per storefront. */
export const catalog: Record<string, unknown> = {
  jp: { kind: 'song', trackId: Number(SONG_ID), trackName: '紙の灯籠', artistName: 'Midori Vale', collectionName: '夜市', trackTimeMillis: 50000, trackViewUrl: 'https://music.apple.com/jp/album/x/1?i=9900112233' },
  us: { kind: 'song', trackId: Number(SONG_ID), trackName: 'Paper Lanterns', artistName: 'Midori Vale', collectionName: 'Night Market', trackTimeMillis: 50000, trackViewUrl: 'https://music.apple.com/us/album/x/1?i=9900112233' },
};

/** A one-pixel PNG, for an album's cover. */
export const COVER_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');

/** The folders and ports the test NAS uses. */
export const NAS = {
  port: 4195,
  webPort: 5180,
  library: '.cache/e2e/library',
  data: '.cache/e2e/data',
  get base() { return `http://localhost:${this.port}/api/`; },
  get app() { return `http://localhost:${this.webPort}/`; },
};
