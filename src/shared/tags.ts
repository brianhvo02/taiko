/**
 * Reads a song's tags from the first bytes of its file. Used by the player (files picked on the device) and by the
 * NAS server (the library scan), so it touches neither the DOM nor Node.
 *
 * Understood: FLAC (Vorbis comments, and the length from STREAMINFO) and ID3v2.2 to 2.4 text frames (MP3, and FLAC
 * or WAV files that carry an ID3 tag). MP4 and Ogg tags are not read; callers fall back to the file name.
 */

export interface Tags {
  title: string;
  artist: string;
  album: string;
  trackNumber: number | null;
  discNumber: number | null;
  durationSeconds: number | null;
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
}

/** How much of a file's start to hand to `readTags`. Tags sit before the audio, ahead of any large cover picture. */
export const TAG_HEAD_BYTES = 256 * 1024;

type Field = 'title' | 'artist' | 'album' | 'trackNumber' | 'discNumber'
  | 'titleRoman' | 'artistRoman' | 'albumRoman' | 'titleEnglish' | 'artistEnglish' | 'albumEnglish' | 'appleSongId';

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
};

const ID3_FIELDS: Record<string, Field> = {
  TIT2: 'title', TPE1: 'artist', TALB: 'album', TRCK: 'trackNumber', TPOS: 'discNumber',
  TT2: 'title', TP1: 'artist', TAL: 'album', TRK: 'trackNumber', TPA: 'discNumber',
  TSOT: 'titleRoman', TSOP: 'artistRoman', TSOA: 'albumRoman',
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
    const field = equals > 0 ? VORBIS_FIELDS[entry.slice(0, equals).toUpperCase()] : undefined;
    if (field) set(tags, field, entry.slice(equals + 1));
  }
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

/**
 * Reads a file's tags through a reader. A FLAC file is walked block by block, so its tags are found wherever they
 * sit: some taggers put a cover picture of several megabytes ahead of them, far past `TAG_HEAD_BYTES`. Only the
 * block headers, the stream details and the comments are read, never the picture. Any other format is read from
 * its first `TAG_HEAD_BYTES`. Never throws.
 */
export async function readTagsFrom(read: TagReader, size: number): Promise<Tags> {
  const tags = NO_TAGS();
  try {
    let at = 0;
    const start = await read(0, 10);
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
