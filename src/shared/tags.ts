/**
 * Reads a song's tags from the first bytes of its file. Used by the player (files picked on the device) and by the
 * NAS server (the library scan), so it touches neither the DOM nor Node.
 *
 * Understood: FLAC (Vorbis comments, and the length from STREAMINFO) and ID3v2.2 to 2.4 text frames (MP3, and FLAC
 * or WAV files that carry an ID3 tag) and, through a reader, MP4 (.m4a: the iTunes item list and the length from
 * the movie header). Ogg tags are not read; callers fall back to the file name.
 */

export interface Tags {
  title: string;
  artist: string;
  album: string;
  trackNumber: number | null;
  discNumber: number | null;
  durationSeconds: number | null;
  /** How the audio is stored, for a FLAC file: samples a second, and bits in each. */
  sampleRate?: number;
  bitsPerSample?: number;
  /**
   * How loud the song and its album are, from the ReplayGain tags when the file has them: the change in decibels
   * that brings each to the common level (-18 LUFS), and the highest peak as a linear number (it can be over 1).
   */
  trackGain?: number;
  trackPeak?: number;
  albumGain?: number;
  albumPeak?: number;
  /**
   * Other forms of the names, present only when the file has them: the reading in Latin script (the TITLESORT,
   * ARTISTSORT and ALBUMSORT tags, which for Japanese music hold the romaji), the official English name
   * (TITLE_EN, ARTIST_EN, ALBUM_EN) and the Apple Music song id (APPLE_SONG_ID).
   */
  titleRoman?: string;
  artistRoman?: string;
  albumRoman?: string;
  titleEnglish?: string;
  artistEnglish?: string;
  albumEnglish?: string;
  appleSongId?: string;
  /** The album's artist (ALBUMARTIST), its reading (ALBUMARTISTSORT), and the release date as tagged (DATE). */
  albumArtist?: string;
  albumArtistRoman?: string;
  date?: string;
}

/** How much of a file's start to hand to `readTags`. Tags sit before the audio, ahead of any large cover picture. */
export const TAG_HEAD_BYTES = 256 * 1024;

type Field = 'title' | 'artist' | 'album' | 'trackNumber' | 'discNumber'
  | 'titleRoman' | 'artistRoman' | 'albumRoman' | 'titleEnglish' | 'artistEnglish' | 'albumEnglish' | 'appleSongId'
  | 'albumArtist' | 'albumArtistRoman' | 'date';

const VORBIS_FIELDS: Record<string, Field> = {
  TITLE: 'title',
  ARTIST: 'artist',
  ALBUM: 'album',
  TRACKNUMBER: 'trackNumber',
  DISCNUMBER: 'discNumber',
  TITLESORT: 'titleRoman',
  ARTISTSORT: 'artistRoman',
  ALBUMSORT: 'albumRoman',
  TITLE_EN: 'titleEnglish',
  ARTIST_EN: 'artistEnglish',
  ALBUM_EN: 'albumEnglish',
  APPLE_SONG_ID: 'appleSongId',
  ALBUMARTIST: 'albumArtist',
  ALBUMARTISTSORT: 'albumArtistRoman',
  DATE: 'date',
};

const LOUDNESS_FIELDS: Record<string, 'trackGain' | 'trackPeak' | 'albumGain' | 'albumPeak'> = {
  REPLAYGAIN_TRACK_GAIN: 'trackGain',
  REPLAYGAIN_TRACK_PEAK: 'trackPeak',
  REPLAYGAIN_ALBUM_GAIN: 'albumGain',
  REPLAYGAIN_ALBUM_PEAK: 'albumPeak',
};

const ID3_FIELDS: Record<string, Field> = {
  TIT2: 'title', TPE1: 'artist', TALB: 'album', TRCK: 'trackNumber', TPOS: 'discNumber',
  TT2: 'title', TP1: 'artist', TAL: 'album', TRK: 'trackNumber', TPA: 'discNumber',
  TSOT: 'titleRoman', TSOP: 'artistRoman', TSOA: 'albumRoman',
  TPE2: 'albumArtist', TSO2: 'albumArtistRoman', TDRC: 'date', TYER: 'date',
};

/** iTunes items in an MP4 file. Names agreed for FLAC (TITLE_EN and the rest) are read from free-form items too. */
const MP4_FIELDS: Record<string, Field> = {
  '\u00a9nam': 'title', '\u00a9ART': 'artist', '\u00a9alb': 'album', aART: 'albumArtist', '\u00a9day': 'date',
  trkn: 'trackNumber', disk: 'discNumber',
  sonm: 'titleRoman', soar: 'artistRoman', soal: 'albumRoman', soaa: 'albumArtistRoman',
};

const utf8 = new TextDecoder('utf-8');

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (start + length > bytes.length) return '';
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function syncsafe(bytes: Uint8Array, at: number): number {
  return ((bytes[at] & 0x7f) << 21) | ((bytes[at + 1] & 0x7f) << 14) | ((bytes[at + 2] & 0x7f) << 7) | (bytes[at + 3] & 0x7f);
}

function be32(bytes: Uint8Array, at: number): number {
  return bytes[at] * 2 ** 24 + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]);
}

/** Keeps the first value seen for a field. Numbers read "3" and "3/12" alike. */
function set(tags: Tags, field: Field, value: string): void {
  const text = value.trim();
  if (!text) return;
  if (field === 'trackNumber' || field === 'discNumber') {
    const n = parseInt(text, 10);
    if (tags[field] === null && Number.isFinite(n) && n > 0) tags[field] = n;
  } else if (!tags[field]) {
    tags[field] = text;
  }
}

function readVorbisComments(block: Uint8Array, tags: Tags): void {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  if (block.length < 8) return;
  let at = 4 + view.getUint32(0, true);
  if (at + 4 > block.length) return;
  const count = view.getUint32(at, true);
  at += 4;
  for (let i = 0; i < count && at + 4 <= block.length; i++) {
    const length = view.getUint32(at, true);
    at += 4;
    if (at + length > block.length) return;
    const entry = utf8.decode(block.subarray(at, at + length));
    at += length;
    const equals = entry.indexOf('=');
    const name = equals > 0 ? entry.slice(0, equals).toUpperCase() : '';
    const field = VORBIS_FIELDS[name];
    if (field) set(tags, field, entry.slice(equals + 1));
    const loudness = LOUDNESS_FIELDS[name];
    // "-10.27 dB" for a gain, "1.091440" for a peak: the number at the start is the value.
    if (loudness && tags[loudness] === undefined) {
      const value = parseFloat(entry.slice(equals + 1));
      if (Number.isFinite(value) && Math.abs(value) < 100 && (loudness.endsWith('Gain') || value >= 0)) tags[loudness] = value;
    }
  }
}

/** STREAMINFO's sample rate, and its bits per sample: five bits across two bytes, stored as one less. */
function noteQuality(tags: Tags, rate: number, byte12: number, byte13: number): void {
  if (rate <= 0) return;
  tags.sampleRate = rate;
  tags.bitsPerSample = (((byte12 & 0x01) << 4) | (byte13 >> 4)) + 1;
}

function readFlac(bytes: Uint8Array, start: number, tags: Tags): void {
  let at = start;
  while (at + 4 <= bytes.length) {
    const header = bytes[at];
    const type = header & 0x7f;
    const length = (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    const body = at + 4;
    const end = body + length;
    if (end > bytes.length) return;
    if (type === 0 && length >= 18) {
      // STREAMINFO: a 20-bit sample rate at byte 10, and a 36-bit count of samples ending at byte 17.
      const rate = (bytes[body + 10] << 12) | (bytes[body + 11] << 4) | (bytes[body + 12] >> 4);
      const samples = (bytes[body + 13] & 0x0f) * 2 ** 32 + be32(bytes, body + 14);
      if (rate > 0 && samples > 0) tags.durationSeconds = samples / rate;
      noteQuality(tags, rate, bytes[body + 12], bytes[body + 13]);
    }
    if (type === 4) readVorbisComments(bytes.subarray(body, end), tags);
    if (header & 0x80) return;
    at = end;
  }
}

function decodeId3Text(frame: Uint8Array): string {
  if (frame.length < 2) return '';
  const encoding = frame[0];
  let body = frame.subarray(1);
  let text: string;
  if (encoding === 1 || encoding === 2) {
    let label = encoding === 2 ? 'utf-16be' : 'utf-16le';
    if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) { label = 'utf-16be'; body = body.subarray(2); }
    else if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) { label = 'utf-16le'; body = body.subarray(2); }
    text = new TextDecoder(label).decode(body);
  } else if (encoding === 3) {
    text = utf8.decode(body);
  } else {
    text = new TextDecoder('windows-1252').decode(body);
  }
  const end = text.indexOf('\0');
  return end >= 0 ? text.slice(0, end) : text;
}

function readId3(tag: Uint8Array, tags: Tags): void {
  const major = tag[3];
  if (major < 2 || major > 4) return;
  let at = 10;
  if (major > 2 && tag[5] & 0x40 && tag.length >= 14) at += major === 4 ? syncsafe(tag, 10) : be32(tag, 10) + 4;
  const idLength = major === 2 ? 3 : 4;
  const headerLength = major === 2 ? 6 : 10;
  while (at + headerLength <= tag.length) {
    const id = ascii(tag, at, idLength);
    if (!/^[A-Z0-9]+$/.test(id)) return;
    const size = major === 2
      ? (tag[at + 3] << 16) | (tag[at + 4] << 8) | tag[at + 5]
      : major === 4 ? syncsafe(tag, at + 4) : be32(tag, at + 4);
    const body = at + headerLength;
    const end = body + size;
    if (size <= 0 || end > tag.length) return;
    const field = ID3_FIELDS[id];
    if (field) set(tags, field, decodeId3Text(tag.subarray(body, end)));
    at = end;
  }
}

/** Reads `length` bytes of a file at `offset`; fewer at its end. */
export type TagReader = (offset: number, length: number) => Promise<Uint8Array>;

const NO_TAGS = (): Tags => ({ title: '', artist: '', album: '', trackNumber: null, discNumber: null, durationSeconds: null });

interface Atom {
  type: string;
  body: number;
  end: number;
}

/** The MP4 atom at `at`, when it is whole and inside `limit`. */
async function atomAt(read: TagReader, at: number, limit: number): Promise<Atom | null> {
  if (at + 8 > limit) return null;
  const header = await read(at, 16);
  if (header.length < 8) return null;
  let size = be32(header, 0);
  let head = 8;
  if (size === 1) {
    if (header.length < 16) return null;
    size = be32(header, 8) * 2 ** 32 + be32(header, 12);
    head = 16;
  } else if (size === 0) {
    size = limit - at;
  }
  if (size < head || at + size > limit) return null;
  return { type: ascii(header, 4, 4), body: at + head, end: at + size };
}

async function findAtom(read: TagReader, from: number, limit: number, type: string): Promise<Atom | null> {
  for (let at = from, seen = 0; seen < 4096; seen++) {
    const atom = await atomAt(read, at, limit);
    if (!atom) return null;
    if (atom.type === type) return atom;
    at = atom.end;
  }
  return null;
}

/** One iTunes item: its `data` atom, and for a free-form item (`----`) the `name` that says what it is. */
function readMp4Item(type: string, item: Uint8Array, tags: Tags): void {
  let name = '';
  for (let at = 0; at + 8 <= item.length;) {
    const size = be32(item, at);
    if (size < 8 || at + size > item.length) return;
    const kind = ascii(item, at + 4, 4);
    if (kind === 'name' && size >= 12) name = utf8.decode(item.subarray(at + 12, at + size));
    if (kind === 'data' && size >= 16) {
      const field = type === '----' ? VORBIS_FIELDS[name.toUpperCase()] : MP4_FIELDS[type];
      if (!field) return;
      const value = item.subarray(at + 16, at + size);
      // A track or disc number is two zero bytes, the number, then how many there are.
      if (type === 'trkn' || type === 'disk') {
        if (value.length >= 4) set(tags, field, String((value[2] << 8) | value[3]));
      } else if ((be32(item, at + 8) & 0xffffff) === 1) {
        set(tags, field, utf8.decode(value));
      }
      return;
    }
    at += size;
  }
}

/**
 * Walks an MP4 file's atoms to its movie header (for the length) and its iTunes item list. The movie atom can sit
 * after the audio, at the far end of the file; the cover picture among the items is stepped over, not read.
 */
async function readMp4(read: TagReader, size: number, tags: Tags): Promise<void> {
  const moov = await findAtom(read, 0, size, 'moov');
  if (!moov) return;
  const mvhd = await findAtom(read, moov.body, moov.end, 'mvhd');
  if (mvhd) {
    const header = await read(mvhd.body, 32);
    const long = header[0] === 1;
    if (header.length >= (long ? 32 : 20)) {
      const scale = be32(header, long ? 20 : 12);
      const length = long ? be32(header, 24) * 2 ** 32 + be32(header, 28) : be32(header, 16);
      if (scale > 0 && length > 0) tags.durationSeconds = length / scale;
    }
  }
  const udta = await findAtom(read, moov.body, moov.end, 'udta');
  const meta = udta && await findAtom(read, udta.body, udta.end, 'meta');
  // `meta` begins with four bytes of version and flags before its children.
  const list = meta && await findAtom(read, meta.body + 4, meta.end, 'ilst');
  if (!list) return;
  for (let at = list.body, seen = 0; seen < 1024; seen++) {
    const item = await atomAt(read, at, list.end);
    if (!item) return;
    if (item.type !== 'covr' && item.end - item.body <= 64 * 1024) readMp4Item(item.type, await read(item.body, item.end - item.body), tags);
    at = item.end;
  }
}

/**
 * Reads a file's tags through a reader. A FLAC file is walked block by block, so its tags are found wherever they
 * sit: some taggers put a cover picture of several megabytes ahead of them, far past `TAG_HEAD_BYTES`. Only the
 * block headers, the stream details and the comments are read, never the picture. An MP4 file is walked atom by
 * atom in the same way. Any other format is read from its first `TAG_HEAD_BYTES`. Never throws.
 */
export async function readTagsFrom(read: TagReader, size: number): Promise<Tags> {
  const tags = NO_TAGS();
  try {
    let at = 0;
    const start = await read(0, 10);
    if (start.length >= 8 && ascii(start, 4, 4) === 'ftyp') {
      await readMp4(read, size, tags);
      return tags;
    }
    if (start.length >= 10 && ascii(start, 0, 3) === 'ID3') {
      const end = 10 + syncsafe(start, 6);
      readId3(await read(0, Math.min(end, TAG_HEAD_BYTES)), tags);
      at = end;
    }
    if (ascii(await read(at, 4), 0, 4) !== 'fLaC') return at ? tags : readTags(await read(0, Math.min(size, TAG_HEAD_BYTES)));
    at += 4;
    for (let blocks = 0; blocks < 1024 && at + 4 <= size; blocks++) {
      const header = await read(at, 4);
      if (header.length < 4) break;
      const type = header[0] & 0x7f;
      const length = (header[1] << 16) | (header[2] << 8) | header[3];
      const body = at + 4;
      if (type === 0 && length >= 18) {
        const info = await read(body, 18);
        if (info.length >= 18) {
          const rate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
          const samples = (info[13] & 0x0f) * 2 ** 32 + be32(info, 14);
          if (rate > 0 && samples > 0) tags.durationSeconds = samples / rate;
          noteQuality(tags, rate, info[12], info[13]);
        }
      } else if (type === 4 && length <= 4 * 1024 * 1024) {
        readVorbisComments(await read(body, length), tags);
      }
      if (header[0] & 0x80) break;
      at = body + length;
    }
  } catch {
    // A damaged or unreadable file gives whatever was read before the damage.
  }
  return tags;
}

/** Reads what tags it can from the start of an audio file. Unknown formats give empty tags, never an error. */
export function readTags(head: Uint8Array): Tags {
  const tags: Tags = { title: '', artist: '', album: '', trackNumber: null, discNumber: null, durationSeconds: null };
  try {
    let at = 0;
    if (ascii(head, 0, 3) === 'ID3' && head.length >= 10) {
      const end = 10 + syncsafe(head, 6);
      readId3(head.subarray(0, Math.min(head.length, end)), tags);
      at = end;
    }
    if (ascii(head, at, 4) === 'fLaC') readFlac(head, at + 4, tags);
  } catch {
    // A damaged tag gives whatever was read before the damage.
  }
  return tags;
}
