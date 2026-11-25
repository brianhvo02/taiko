/**
 * The contract between the player and the NAS server. Both sides import these types; change this file first when a
 * feature crosses the boundary.
 *
 * Every route lives under the server's PUBLIC_BASE, which ends in `/api/`. Routes marked "paired" need
 * `Authorization: Bearer <token>`, the token a device got from `POST pair`. A failure answers with a JSON
 * `ApiError` and a matching status (400, 401, 403, 404, 405, 413, 416, 429, 500). Codes the player acts on:
 * `bad-code` (403, pairing), `too-many-attempts` (429, pairing), `conflict` (409, playlists), `unauthorized` (401: the device is no longer
 * paired), `bad-ticket` and `expired-ticket` (403, audio).
 *
 *   GET    health                      -> HealthResponse
 *   POST   pair            PairRequest -> PairResponse          (403 `bad-code` when the code is wrong, used or expired)
 *   GET    me                  paired  -> MeResponse
 *   DELETE me                  paired  -> 204                   (forgets this device)
 *   GET    browse?path=        paired  -> BrowseResponse        (a folder's contents; an empty path lists the roots)
 *   GET    cover?path=&exp=&sig=       -> a folder's cover picture, at the address `browse` gave for it
 *   GET    library             paired  -> LibraryResponse       (the albums in the scanned roots; see LIBRARY_SCAN)
 *   GET    library/search?q=   paired  -> SearchResponse        (songs in the scanned roots matching every word of q)
 *   POST   library/scan        paired  -> ScanResponse          (starts a rescan now, unless one is running)
 *   POST   invite              paired  -> InviteResponse        (a code for another device of the same user)
 *   GET    playlists           paired  -> PlaylistsResponse     (the user's own playlists, shared by their devices)
 *   PUT    playlists           paired  PlaylistsUpdate -> PlaylistsResponse  (409 `conflict` when they changed
 *          since `base`: read them again, bring the two together and send again; 400 when they are too many or long)
 *   GET    playlists/shared    paired  -> SharedPlaylistsResponse  (other users' public and collaborative playlists)
 *   PUT    playlists/shared/:owner/:id  paired  SharedPlaylistUpdate -> SharedPlaylist  (the songs of a collaborative
 *          playlist; 403 `not-collaborative` when it is only public, 404 when it isn't shared at all)
 *   GET    favourites          paired  -> FavouritesResponse    (the user's favourite songs and albums)
 *   PUT    favourites/songs/:id        paired  FavouriteSongRequest -> 204   (DELETE takes it away again)
 *   PUT    favourites/albums/:id       paired  FavouriteAlbumRequest -> 204  (:id is the base64url of the album's
 *          folder path; DELETE takes it away again)
 *   POST   plays               paired  PlayRequest -> 204        (the user heard a song: half of it, or four minutes)
 *   GET    history             paired  -> HistoryResponse       (the user's latest plays, most played songs, albums played lately)
 *   POST   plays/counts        paired  PlayCountsRequest -> PlayCountsResponse  (how often the user played some songs)
 *   POST   moved               paired  MovedRequest -> MovedResponse  (where songs that are gone from their old
 *          place went, for playlists and links made before an album was replaced)
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

import type { Playlist, SavedTrack, SharedPlaylist } from './playlists';

export interface ApiError {
  /** A stable code such as `bad-code`, `unauthorized`, `not-found`, `bad-request`. */
  error: string;
}

/** A user's own playlists, shared by all of their devices, and the version they are at. */
export interface PlaylistsResponse {
  version: number;
  playlists: Playlist[];
}

/** The whole set of playlists, as changed from version `base`. */
export interface PlaylistsUpdate {
  base: number;
  playlists: Playlist[];
}

/** A song a user marked as a favourite, and when. */
export interface FavouriteSong {
  track: SavedTrack;
  addedAt: string;
}

/** An album a user marked as a favourite: its folder, and what it was called when it was marked. */
export interface FavouriteAlbum {
  path: string;
  title: string;
  artist: string;
  addedAt: string;
}

export interface FavouritesResponse {
  songs: FavouriteSong[];
  albums: FavouriteAlbum[];
}

export interface FavouriteSongRequest {
  track: SavedTrack;
}

export interface FavouriteAlbumRequest {
  title: string;
  artist: string;
}

/** One time a user heard a song. */
export interface Play {
  at: string;
  track: SavedTrack;
}

export interface PlayRequest {
  track: SavedTrack;
  /** When it was heard, for a play the device couldn't report at the time. Left out: now. */
  at?: string;
}

export interface HistoryResponse {
  /** How many plays there are in all. */
  total: number;
  /** The latest plays, newest first. */
  plays: Play[];
  /** The songs played most, with how often. */
  top: { track: SavedTrack; count: number }[];
  /** The albums (folders) played lately, newest first, as their songs' tags named them. */
  albums: { path: string; title: string; artist: string; at: string }[];
}

export interface PlayCountsRequest {
  ids: string[];
}

export interface PlayCountsResponse {
  counts: Record<string, number>;
}

/** Track ids to look up: songs a device has stored that may have moved. */
export interface MovedRequest {
  ids: string[];
}

/**
 * For each id asked about whose file is gone and which the NAS has a record of: the id of the song's new copy, or
 * null when the fresh album has no such song. An id whose file is still there, or that no record names, is left out.
 */
export interface MovedResponse {
  moved: Record<string, string | null>;
}

/** The most ids one `POST moved` may ask about. */
export const MAX_MOVED_IDS = 5000;

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
  /** Whose device this now is: the user the invite was made for. Missing from a server from before it had users. */
  user?: NasUser;
}

export interface MeResponse {
  serverName: string;
  deviceName: string;
  /** Whose device this is. Missing from a server from before it had users. */
  user?: NasUser;
}

/** Someone who listens on this NAS: the owner, or family and friends the owner has added. */
export interface NasUser {
  id: string;
  name: string;
  /** The person who runs the server. */
  owner: boolean;
}

/** An invite for another device of the same user, made by one of their devices. */
export interface InviteResponse {
  code: string;
  /** The link to open on the other device. */
  link: string;
  expiresAt: string;
}

/** The playlists the other users let this one see. */
export interface SharedPlaylistsResponse {
  playlists: SharedPlaylist[];
}

/** The songs of someone's collaborative playlist, as changed. */
export interface SharedPlaylistUpdate {
  tracks: SavedTrack[];
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
  /** How the audio is stored, known for FLAC: samples a second and bits in each. */
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
  /**
   * An address for the folder's cover picture (cover, folder or front, as JPEG, PNG or WebP), or null when it has
   * none. Signed like an audio link, so an `<img>` can load it without the token, and the same all day so that
   * the browser keeps it.
   */
  cover: string | null;
}

/**
 * An album in the library: one folder that directly holds songs, in a root the server scans (LIBRARY_SCAN names the
 * roots; the others are reached through the folder browser only). Its songs come from `browse` on its `path`.
 */
export interface NasAlbum {
  /** The album's folder, as the folder browser names it. */
  path: string;
  /** The ALBUM tag most of its songs carry; the folder's name when none has one. */
  title: string;
  titleRoman?: string;
  titleEnglish?: string;
  /**
   * The ALBUMARTIST tag most of its songs carry; failing that the ARTIST they all share; '' when they have neither
   * in common (a compilation).
   */
  artist: string;
  artistRoman?: string;
  artistEnglish?: string;
  /** The DATE tag as written (a year, or a full date), from the songs that carry the album's title; '' when untagged. */
  date: string;
  trackCount: number;
  /** The songs' lengths added up, or null when any is unknown. */
  durationSeconds: number | null;
  /**
   * The address of the folder's cover picture, signed like the one `browse` gives, with `size=small`: the folder's
   * small copy (cover.small.jpg) when it has one, for a page of many albums. Null when the folder has no picture.
   */
  cover: string | null;
  /**
   * When the album was added, in milliseconds since 1970: when its folder was made, where the disk says; failing
   * that the newest modified time among its songs. (Retagging a song changes its modified time, not its folder's making.)
   */
  addedAt: number;
}

export interface LibraryResponse {
  serverName: string;
  /** Whether this server keeps a library at all. False when LIBRARY_SCAN is off: only the folder browser is there. */
  enabled: boolean;
  /** Whether a scan is running now. */
  scanning: boolean;
  /** ISO time of the last finished scan, or null before the first one finishes. */
  scannedAt: string | null;
  /** Sorted by artist, then date, then title. */
  albums: NasAlbum[];
}

/** Songs found by `library/search`, best matches first, at most 50. Each is as `browse` would list it. */
export interface SearchResponse {
  tracks: NasTrack[];
}

export interface ScanResponse {
  /** False when a scan was already running (it carries on), or the library is off. */
  started: boolean;
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
