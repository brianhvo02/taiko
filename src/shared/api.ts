/**
 * The contract between the player and the NAS server. Both sides import these types; change this file first when a
 * feature crosses the boundary.
 *
 * Every route lives under the server's PUBLIC_BASE, which ends in `/api/`. Routes marked "paired" need
 * `Authorization: Bearer <token>`, the token a device got from `POST pair`. A failure answers with a JSON
 * `ApiError` and a matching status (400, 401, 403, 404, 405, 413, 416, 429, 500). Codes the player acts on:
 * `bad-code` (403, pairing), `too-many-attempts` (429, pairing), `unauthorized` (401: the device is no longer
 * paired), `bad-ticket` and `expired-ticket` (403, audio).
 *
 *   GET    health                      -> HealthResponse
 *   POST   pair            PairRequest -> PairResponse          (403 `bad-code` when the code is wrong, used or expired)
 *   GET    me                  paired  -> MeResponse
 *   DELETE me                  paired  -> 204                   (forgets this device)
 *   GET    browse?path=        paired  -> BrowseResponse        (a folder's contents; an empty path lists the roots)
 *   GET    library             paired  -> LibraryResponse       (the tag-based library; empty while LIBRARY_SCAN is off)
 *   POST   tracks/:id/ticket   paired  TicketRequest (optional body) -> TicketResponse
 *   GET    tracks/:id/lyrics/:index  paired -> the lyrics file's text, as stored
 *   GET    tracks/:id/audio?exp=&sig=  -> the audio file's bytes, with Range support
 *   GET    tracks/:id/audio?exp=&sig=&at=<byte offset>  -> for a FLAC file, a stream that begins at the frame at that
 *          offset: the 42-byte header from `streamHeader` (src/shared/flac.ts), then the file from there on, with
 *          Range support over that whole stream. 400 `bad-request` when no frame starts at the offset.
 *
 * An `<audio>` element can't send an Authorization header, so audio is fetched with a ticket: a URL signed by the
 * server that works without the token until it expires.
 */

export interface ApiError {
  /** A stable code such as `bad-code`, `unauthorized`, `not-found`, `bad-request`. */
  error: string;
}

export interface HealthResponse {
  ok: true;
  name: 'taiko-server';
  version: string;
}

export interface PairRequest {
  /** The pairing code from an invite, e.g. `ABCD-EFGH-JKLM`. */
  code: string;
  /** What the owner sees this device listed as. */
  deviceName: string;
}

export interface PairResponse {
  token: string;
  serverName: string;
  deviceName: string;
}

export interface MeResponse {
  serverName: string;
  deviceName: string;
}

export type LyricsFormat = 'json' | 'ttml' | 'lrc';

export interface NasLyricsFile {
  /** The position to ask `tracks/:id/lyrics/:index` for. */
  index: number;
  /** The file's name, for display. */
  name: string;
  format: LyricsFormat;
}

export interface NasTrack {
  /**
   * Names the file: the base64url of `<root name>/<path under the root>`. The server checks the path it decodes
   * (no `..`, nothing outside the root) on every request, so an id can be used without a scan having listed it.
   */
  id: string;
  /** From the file's tags; the file name without its extension when there is no title tag. */
  title: string;
  /** Empty when the file has no artist tag. */
  artist: string;
  /** Empty when the file has no album tag. */
  album: string;
  trackNumber: number | null;
  discNumber: number | null;
  /** Known for FLAC; null where the server can't tell without decoding. */
  durationSeconds: number | null;
  /** Lyrics files found beside the audio file. Several versions of one song are combined by the player. */
  lyrics: NasLyricsFile[];
}

/** A folder in the browser. Its path is the root's name and the folders under it, joined with `/`. */
export interface NasFolder {
  name: string;
  path: string;
}

/**
 * One folder, read when asked for. Its tracks carry their tags (FLAC and ID3; a file without a title tag is named
 * after its file). Folders come first when shown; both lists are sorted by file name, numbers in order ("2"
 * before "10"), whatever the tags say.
 */
export interface BrowseResponse {
  serverName: string;
  /** The folder listed; '' for the list of roots. */
  path: string;
  /** The folder above, '' for the roots, or null when this is the list of roots. */
  parent: string | null;
  folders: NasFolder[];
  tracks: NasTrack[];
}

export interface LibraryResponse {
  serverName: string;
  /** ISO time of the last finished scan, or null while the first one runs. */
  scannedAt: string | null;
  tracks: NasTrack[];
}

/**
 * Browsers seek FLAC files only roughly (Safari most of all), so the player never asks them to: to play from a
 * time, it asks for a ticket whose audio begins there. See src/shared/flac.ts.
 */
export interface TicketRequest {
  /** Start the audio at this time. Left out or 0: the whole file. Ignored for a file the server can't start mid-way. */
  fromSeconds?: number;
}

export interface TicketResponse {
  /** An absolute URL for the track's audio that needs no token. */
  url: string;
  /** ISO time after which the URL stops working. */
  expiresAt: string;
  /** Whether this track's audio can start at an exact time: it is a FLAC file the server could index. */
  exactSeek: boolean;
  /** The time the audio at `url` starts at: 0 for the whole file, else the start of the frame holding `fromSeconds`. */
  startSeconds: number;
  /** The track's full length, known when `exactSeek` is true; null otherwise. */
  totalSeconds: number | null;
}

/** The id of the track at a path (`<root name>/<folders>/<file>`): its base64url, without padding. */
export function trackIdOf(path: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(path)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The path a track id names, or null when it isn't one. */
export function pathOfTrackId(id: string): string | null {
  try {
    const binary = atob(id.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** The file extensions the server lists and the player accepts as audio. */
export const AUDIO_EXTENSIONS = ['flac', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav'] as const;

/** The file extensions read as lyrics. */
export const LYRICS_EXTENSIONS = ['json', 'ttml', 'lrc'] as const;

/**
 * Whether a lyrics file belongs to an audio file, by name: `Song.flac` takes `Song.json`, `Song.ttml`, `Song.lrc`
 * and versions such as `Song.ja-Latn.json` or `Song_en.json`. Both names are given without their folders.
 */
export function lyricsBelongTo(lyricsName: string, audioName: string): boolean {
  const stem = audioName.replace(/\.[^.]+$/, '').toLowerCase();
  const lyrics = lyricsName.replace(/\.[^.]+$/, '').toLowerCase();
  if (!stem) return false;
  return lyrics === stem || lyrics.startsWith(`${stem}.`) || lyrics.startsWith(`${stem}_`);
}
