/**
 * The player's side of the NAS server (see `src/shared/api.ts` for the contract). A device pairs once with a code
 * from the owner's invite link; the token it gets back is kept in this browser's storage.
 */
import { toPlaylists } from '../shared/playlists';
import type { InviteResponse, MeResponse, NasUser, SharedPlaylistsResponse } from '../shared/api';
import type { SavedTrack, SharedPlaylist } from '../shared/playlists';
import type { ApiError, BrowseResponse, LibraryResponse, MovedRequest, MovedResponse, PairRequest, PairResponse, PlaylistsResponse, PlaylistsUpdate, ScanResponse, SearchResponse, TicketRequest, TicketResponse } from '../shared/api';

export interface Pairing {
  /** The server's API base, ending in `/api/`. */
  base: string;
  token: string;
  serverName: string;
  deviceName: string;
  /** Whose device this is, on a NAS that has users. */
  user?: NasUser;
}

export interface PairLink {
  base: string;
  code: string;
}

export class NasError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

const STORAGE_KEY = 'taiko:nas';

export function loadPairing(): Pairing | null {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Pairing | null;
    return stored && stored.base && stored.token ? stored : null;
  } catch {
    return null;
  }
}

export function savePairing(pairing: Pairing | null): void {
  try {
    if (pairing) localStorage.setItem(STORAGE_KEY, JSON.stringify(pairing));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Without storage the pairing lasts until the tab closes.
  }
}

/**
 * A server address as typed or linked: https, or plain http only for this machine (development). Returns the
 * base with a trailing slash, or null when it isn't an address the player will talk to.
 */
export function normalizeBase(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  if (url.username || url.password) return null;
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

/** Reads an invite link's fragment: `#pair=<server base>&code=<code>`. */
export function parsePairLink(hash: string): PairLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const base = normalizeBase(params.get('pair') ?? '');
  const code = (params.get('code') ?? '').trim();
  return base && code ? { base, code } : null;
}

/** A suggestion for the device's name, which the person can edit. It gates nothing. */
export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return system ? `${browser} on ${system}` : browser;
}

async function request(base: string, path: string, init: RequestInit, token?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(base + path, { ...init, headers });
  } catch {
    throw new NasError('unreachable', 0);
  }
  if (!response.ok) {
    let code = 'failed';
    try {
      code = ((await response.json()) as ApiError).error || code;
    } catch {
      // Not a JSON error body.
    }
    throw new NasError(code, response.status);
  }
  return response;
}

export async function pair(link: PairLink, deviceName: string): Promise<Pairing> {
  const body: PairRequest = { code: link.code, deviceName: deviceName.trim() || defaultDeviceName() };
  const response = await request(link.base, 'pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const paired = (await response.json()) as PairResponse;
  const pairing: Pairing = { base: link.base, token: paired.token, serverName: paired.serverName, deviceName: paired.deviceName, ...(paired.user ? { user: paired.user } : {}) };
  savePairing(pairing);
  return pairing;
}

/** Lists one folder on the NAS; an empty path lists its roots. */
export async function fetchFolder(pairing: Pairing, path: string): Promise<BrowseResponse> {
  return (await request(pairing.base, `browse?path=${encodeURIComponent(path)}`, {}, pairing.token)).json() as Promise<BrowseResponse>;
}

/** The NAS's album library. A server from before it kept one answers without these fields; that reads as "off". */
export async function fetchLibrary(pairing: Pairing): Promise<LibraryResponse> {
  const library = (await (await request(pairing.base, 'library', {}, pairing.token)).json()) as Partial<LibraryResponse>;
  return {
    serverName: library.serverName ?? pairing.serverName,
    enabled: library.enabled === true,
    scanning: library.scanning === true,
    scannedAt: library.scannedAt ?? null,
    albums: Array.isArray(library.albums) ? library.albums : [],
  };
}

export async function searchLibrary(pairing: Pairing, query: string): Promise<SearchResponse> {
  return (await request(pairing.base, `library/search?q=${encodeURIComponent(query)}`, {}, pairing.token)).json() as Promise<SearchResponse>;
}

/** Asks the NAS to read its library again now. */
export async function startScan(pairing: Pairing): Promise<ScanResponse> {
  return (await request(pairing.base, 'library/scan', { method: 'POST' }, pairing.token)).json() as Promise<ScanResponse>;
}

/** The playlists the NAS keeps for every paired device. Null from a server that doesn't keep any yet. */
export async function fetchPlaylists(pairing: Pairing): Promise<PlaylistsResponse | null> {
  try {
    const reply = (await (await request(pairing.base, 'playlists', {}, pairing.token)).json()) as Partial<PlaylistsResponse>;
    return typeof reply.version === 'number' ? { version: reply.version, playlists: toPlaylists(reply.playlists) } : null;
  } catch (error) {
    if (error instanceof NasError && (error.status === 404 || error.status === 405)) return null;
    throw error;
  }
}

/** Sends the playlists as changed from version `base`. Null when the NAS's have changed since: look again. */
export async function sendPlaylists(pairing: Pairing, update: PlaylistsUpdate): Promise<PlaylistsResponse | null> {
  try {
    const init = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update) };
    return (await (await request(pairing.base, 'playlists', init, pairing.token)).json()) as PlaylistsResponse;
  } catch (error) {
    if (error instanceof NasError && error.status === 409) return null;
    throw error;
  }
}

/** Who this device belongs to, as the NAS has it now (a user can be renamed). Null from a server without users. */
export async function fetchUser(pairing: Pairing): Promise<NasUser | null> {
  const me = (await (await request(pairing.base, 'me', {}, pairing.token)).json()) as MeResponse;
  return me.user ?? null;
}

/** Makes an invite for another device of this device's user. */
export async function makeInvite(pairing: Pairing): Promise<InviteResponse> {
  return (await request(pairing.base, 'invite', { method: 'POST' }, pairing.token)).json() as Promise<InviteResponse>;
}

/** The playlists other users let this one see. None from a server without users. */
export async function fetchSharedPlaylists(pairing: Pairing): Promise<SharedPlaylist[]> {
  try {
    const reply = (await (await request(pairing.base, 'playlists/shared', {}, pairing.token)).json()) as Partial<SharedPlaylistsResponse>;
    return Array.isArray(reply.playlists) ? reply.playlists.filter((playlist) => playlist && typeof playlist.id === 'string' && playlist.owner && Array.isArray(playlist.tracks)) : [];
  } catch (error) {
    if (error instanceof NasError && (error.status === 404 || error.status === 405)) return [];
    throw error;
  }
}

/** Replaces the songs of someone else's collaborative playlist. */
export async function sendSharedTracks(pairing: Pairing, ownerId: string, playlistId: string, tracks: SavedTrack[]): Promise<SharedPlaylist> {
  const init = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tracks }) };
  return (await request(pairing.base, `playlists/shared/${encodeURIComponent(ownerId)}/${encodeURIComponent(playlistId)}`, init, pairing.token)).json() as Promise<SharedPlaylist>;
}

/**
 * Asks where songs went whose album was replaced by a fresh copy: for each id that has moved, the new id, or null
 * when the fresh album has no such song. Empty from a server that keeps no such record.
 */
export async function fetchMoved(pairing: Pairing, ids: string[]): Promise<MovedResponse['moved']> {
  if (!ids.length) return {};
  try {
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids } satisfies MovedRequest) };
    const reply = (await (await request(pairing.base, 'moved', init, pairing.token)).json()) as Partial<MovedResponse>;
    return typeof reply.moved === 'object' && reply.moved !== null ? reply.moved : {};
  } catch (error) {
    if (error instanceof NasError && (error.status === 404 || error.status === 405)) return {};
    throw error;
  }
}

const PATH_KEY = 'taiko:nas-path';

/** The folder the browser showed last, so it reopens there. */
export function loadLastPath(): string {
  try {
    return localStorage.getItem(PATH_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveLastPath(path: string): void {
  try {
    localStorage.setItem(PATH_KEY, path);
  } catch {
    // Without storage the browser starts at the roots.
  }
}

/** A link to a track's audio. With `fromSeconds`, a FLAC track's audio begins at that time (see src/shared/flac.ts). */
export async function fetchTicket(pairing: Pairing, trackId: string, fromSeconds = 0): Promise<TicketResponse> {
  const body: TicketRequest = { fromSeconds };
  const init: RequestInit = fromSeconds > 0
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'POST' };
  return (await request(pairing.base, `tracks/${encodeURIComponent(trackId)}/ticket`, init, pairing.token)).json() as Promise<TicketResponse>;
}

export async function fetchLyrics(pairing: Pairing, trackId: string, index: number): Promise<string> {
  return (await request(pairing.base, `tracks/${encodeURIComponent(trackId)}/lyrics/${index}`, {}, pairing.token)).text();
}

/** Forgets the pairing here and, when the server can be reached, there too. */
export async function forget(pairing: Pairing): Promise<void> {
  savePairing(null);
  try {
    await request(pairing.base, 'me', { method: 'DELETE' }, pairing.token);
  } catch {
    // The device is forgotten locally either way; the owner can remove it on the server.
  }
}

export function clearPairing(): void {
  savePairing(null);
}
