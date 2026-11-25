/** The request handler: every route of `src/shared/api.ts`, mounted at the path of `PUBLIC_BASE`. */
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ApiError, BrowseResponse, HealthResponse, LibraryResponse, MeResponse, PairResponse, ScanResponse, SearchResponse,
  InviteResponse, MovedResponse, NasUser, PlaylistsResponse, SharedPlaylistsResponse, TicketRequest, TicketResponse,
} from '../../src/shared/api';
import { MAX_MOVED_IDS } from '../../src/shared/api';
import { acceptPlaylists, acceptTracks } from '../../src/shared/playlists';
import type { SharedPlaylist } from '../../src/shared/playlists';
import { MAX_DEVICE_NAME_LENGTH, RateLimiter, TICKET_LIFETIME_SECONDS, signTicket, verifyTicket } from './auth';
import type { Device, PairingStore, User } from './auth';
import { DEFAULT_PAIR_ATTEMPTS } from './config';
import type { Config } from './config';
import { flacSeek } from './flac-file';
import { nasTrack } from './library';
import type { Library } from './library';
import type { PlaylistStore } from './playlists';
import { MovedRecord } from './moved';
import { LibraryPaths, byNameNumeric, decodeTrackId, encodeTrackId, listFolder } from './paths';
import type { FolderListing, ResolvedTrack } from './paths';
import { sendAudioFile } from './ranges';
import { VERSION } from './version';
import { TagCache } from './tag-cache';
import { findCover, sendCover } from './cover';

export const MAX_JSON_BODY_BYTES = 16 * 1024;
/** The playlists arrive whole, so their body may be far larger than any other. */
export const MAX_PLAYLISTS_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_MOVED_BODY_BYTES = 4 * 1024 * 1024;
export { DEFAULT_PAIR_ATTEMPTS as PAIR_ATTEMPTS } from './config';
export const PAIR_WINDOW_MS = 10 * 60 * 1000;
/** Invites a device may make for its own user in that window, and how long each lasts. */
export const DEVICE_INVITES = 5;
export const DEVICE_INVITE_DAYS = 1;
/** A device may ask for a rescan this often; sooner, it is told none was started. */
export const SCAN_REQUEST_GAP_MS = 10_000;
export const MAX_SEARCH_CHARS = 200;

export interface AppDeps {
  config: Pick<Config, 'publicBase' | 'basePath' | 'serverName' | 'appOrigins' | 'roots'> & Partial<Pick<Config, 'pairAttempts'>>;
  /** The albums and songs of the scanned roots; off and empty when `LIBRARY_SCAN` names none. */
  library: Pick<Library, 'enabled' | 'scanning' | 'scannedAt' | 'albums' | 'search' | 'scan'>;
  /** The cache the library scan reads tags through, so the browser shares it. Left out: one of the app's own. */
  tags?: TagCache;
  pairing: PairingStore;
  /** The playlists the paired devices share. */
  playlists: PlaylistStore;
  /** Signs tickets. */
  secret: Buffer;
  now?: () => number;
  log?: (message: string) => void;
}

const publicUser = (user: User): NasUser => ({ id: user.id, name: user.name, owner: user.owner === true });

/** An error answered as `{ error: code }` with `status`. */
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/** Whether a browser page at `origin` may call the server: the players of `APP_URL`, and localhost for development. */
export function originAllowed(origin: string | undefined, appOrigins: readonly string[]): boolean {
  if (!origin) return false;
  return appOrigins.includes(origin) || LOCAL_ORIGIN.test(origin);
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : text);
}

function sendError(req: IncomingMessage, res: ServerResponse, status: number, code: string): void {
  sendJson(req, res, status, { error: code } satisfies ApiError);
}

/** The request's JSON object. `optional` takes no body at all (or only white space) as `{}`. */
async function readJsonBody(req: IncomingMessage, optional = false, limit = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown>> {
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new HttpError(413, 'too-large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'too-large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (optional && !text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad-request');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'bad-request');
  return parsed as Record<string, unknown>;
}

/** A lyrics file as UTF-8. Files saved as UTF-16 (with a byte-order mark) are converted; anything else goes as stored. */
function lyricsText(bytes: Buffer): Buffer {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return Buffer.from(new TextDecoder('utf-16le').decode(bytes));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(new TextDecoder('utf-16be').decode(bytes));
  return bytes;
}

export function createApp(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { config, library, pairing, secret } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const pairLimit = new RateLimiter(config.pairAttempts ?? DEFAULT_PAIR_ATTEMPTS, PAIR_WINDOW_MS);
  const inviteLimit = new RateLimiter(DEVICE_INVITES, PAIR_WINDOW_MS);
  const paths = new LibraryPaths(config.roots);
  const moved = new MovedRecord(config.roots);
  const tags = deps.tags ?? new TagCache();
  /** When each device last asked for a rescan. */
  const scanAsked = new Map<string, number>();

  function requireDevice(req: IncomingMessage): Device {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    const device = match ? pairing.authenticate(match[1]) : null;
    if (!device) throw new HttpError(401, 'unauthorized');
    return device;
  }

  function allow(req: IncomingMessage, ...methods: string[]): void {
    const method = req.method === 'HEAD' ? 'GET' : req.method ?? '';
    if (!methods.includes(method)) throw new HttpError(405, 'method-not-allowed');
  }

  /** The file a track id names. The id is checked here on every request; no scan has to have listed it. */
  async function requireTrack(id: string): Promise<ResolvedTrack> {
    const track = await paths.resolveTrack(id);
    if (!track) throw new HttpError(404, 'not-found');
    return track;
  }

  /**
   * The address of the cover of the folder at `folderPath` (as the browser names it). Signed until the end of the
   * day after next, so it stays the same all day and a browser keeps the picture.
   */
  function coverUrl(folderPath: string): string {
    const exp = (Math.floor(now() / 86_400_000) + 2) * 86_400;
    return `${config.publicBase}cover?path=${encodeURIComponent(folderPath)}&exp=${exp}&sig=${signTicket(secret, `cover:${folderPath}`, exp)}`;
  }

  async function browse(browsePath: string): Promise<BrowseResponse> {
    if (!browsePath) {
      const folders = config.roots.map((root) => ({ name: root.name, path: root.name }));
      return { serverName: config.serverName, path: '', parent: null, folders, tracks: [], cover: null };
    }
    const folder = await paths.resolveFolder(browsePath);
    if (!folder) throw new HttpError(404, 'not-found');
    let listing: FolderListing;
    try {
      listing = await listFolder(folder.real, folder.rootReal);
    } catch {
      throw new HttpError(404, 'not-found');
    }
    const here = [folder.root.name, ...folder.parts];
    // The songs stay in file-name order; their tags name them. Tags are read the first time a folder is opened
    // and remembered while the files don't change (tag-cache.ts).
    const files = [...listing.audio].sort(byNameNumeric);
    const read = await tags.readAll(files.map((file) => file.path));
    const tracks = files.map((file, i) => nasTrack(here, file, read[i]));
    return {
      cover: (await findCover(folder.real)) ? coverUrl(here.join('/')) : null,
      serverName: config.serverName,
      path: here.join('/'),
      parent: here.slice(0, -1).join('/'),
      folders: listing.folders.map((entry) => ({ name: entry.name, path: [...here, entry.name].join('/') })).sort(byNameNumeric),
      tracks,
    };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://server.invalid');
    } catch {
      throw new HttpError(400, 'bad-request');
    }
    if (!url.pathname.startsWith(config.basePath)) throw new HttpError(404, 'not-found');
    const parts = url.pathname.slice(config.basePath.length).split('/');

    if (parts.length === 1 && parts[0] === 'health') {
      allow(req, 'GET');
      sendJson(req, res, 200, { ok: true, name: 'taiko-server', version: VERSION } satisfies HealthResponse);
      return;
    }

    if (parts.length === 1 && parts[0] === 'pair') {
      allow(req, 'POST');
      // The address is the connection's own. Behind a reverse proxy that is the proxy's, so the limit is then shared
      // by everyone, which is still a limit; a forwarded header isn't believed, because anyone can send one.
      if (!pairLimit.allow(req.socket.remoteAddress ?? 'unknown', now())) throw new HttpError(429, 'too-many-attempts');
      const body = await readJsonBody(req);
      const deviceName = typeof body.deviceName === 'string' ? body.deviceName.trim() : '';
      if (typeof body.code !== 'string' || !deviceName || deviceName.length > MAX_DEVICE_NAME_LENGTH) {
        throw new HttpError(400, 'bad-request');
      }
      const paired = pairing.redeem(body.code, deviceName);
      if (!paired) throw new HttpError(403, 'bad-code');
      log(`paired a device: "${paired.device.name}" (${paired.device.id})`);
      sendJson(req, res, 200, { token: paired.token, serverName: config.serverName, deviceName: paired.device.name, user: publicUser(pairing.userOf(paired.device)) } satisfies PairResponse);
      return;
    }

    if (parts.length === 1 && parts[0] === 'me') {
      allow(req, 'GET', 'DELETE');
      const device = requireDevice(req);
      if (req.method === 'DELETE') {
        pairing.removeDevice(device.id);
        log(`a device unpaired itself: "${device.name}" (${device.id})`);
        res.writeHead(204).end();
        return;
      }
      sendJson(req, res, 200, { serverName: config.serverName, deviceName: device.name, user: publicUser(pairing.userOf(device)) } satisfies MeResponse);
      return;
    }

    if (parts.length === 1 && parts[0] === 'cover') {
      allow(req, 'GET');
      // No token here, as for audio: the signature in the address is the permission, for this folder only.
      const coverPath = url.searchParams.get('path') ?? '';
      const check = verifyTicket(secret, `cover:${coverPath}`, url.searchParams.get('exp') ?? '', url.searchParams.get('sig') ?? '', Math.floor(now() / 1000));
      if (check !== 'ok') throw new HttpError(403, check === 'expired' ? 'expired-ticket' : 'bad-ticket');
      const folder = await paths.resolveFolder(coverPath);
      const cover = folder ? await findCover(folder.real, url.searchParams.get('size') === 'small') : null;
      if (!cover || !(await sendCover(req, res, cover))) throw new HttpError(404, 'not-found');
      return;
    }

    if (parts.length === 1 && parts[0] === 'browse') {
      allow(req, 'GET');
      requireDevice(req);
      sendJson(req, res, 200, await browse(url.searchParams.get('path') ?? ''));
      return;
    }

    if (parts.length === 1 && parts[0] === 'library') {
      allow(req, 'GET');
      requireDevice(req);
      // The covers' addresses are made now, not at scan time: they change by the day.
      sendJson(req, res, 200, {
        serverName: config.serverName,
        enabled: library.enabled,
        scanning: library.scanning,
        scannedAt: library.scannedAt,
        albums: library.albums.map(({ hasCover, ...album }) => ({ ...album, cover: hasCover ? `${coverUrl(album.path)}&size=small` : null })),
      } satisfies LibraryResponse);
      return;
    }

    if (parts.length === 2 && parts[0] === 'library' && parts[1] === 'search') {
      allow(req, 'GET');
      requireDevice(req);
      const query = url.searchParams.get('q') ?? '';
      if (query.length > MAX_SEARCH_CHARS) throw new HttpError(400, 'bad-request');
      sendJson(req, res, 200, { tracks: library.search(query) } satisfies SearchResponse);
      return;
    }

    if (parts.length === 2 && parts[0] === 'library' && parts[1] === 'scan') {
      allow(req, 'POST');
      const device = requireDevice(req);
      // Asked again too soon, a device is told nothing started; whatever scan is running carries on.
      const at = now();
      const last = scanAsked.get(device.id);
      let started = false;
      if (last === undefined || at - last >= SCAN_REQUEST_GAP_MS) {
        scanAsked.set(device.id, at);
        started = library.scan();
      }
      sendJson(req, res, 200, { started } satisfies ScanResponse);
      return;
    }

    if (parts.length === 1 && parts[0] === 'moved') {
      allow(req, 'POST');
      requireDevice(req);
      const { ids } = await readJsonBody(req, false, MAX_MOVED_BODY_BYTES);
      if (!Array.isArray(ids) || ids.length > MAX_MOVED_IDS || !ids.every((id) => typeof id === 'string')) throw new HttpError(400, 'bad-request');
      const found: Record<string, string | null> = {};
      // A song has moved when its file is gone and a record says where its fresh copy is, and that copy is there.
      const look = async (id: string): Promise<void> => {
        const old = decodeTrackId(id);
        if (old === null || (await paths.resolveTrack(id))) return;
        const where = await moved.lookup(old);
        if (where === undefined) return;
        if (!where) {
          found[id] = null;
          return;
        }
        const [root, ...rest] = where.split('/');
        const fresh = encodeTrackId(root, rest);
        if (await paths.resolveTrack(fresh)) found[id] = fresh;
      };
      const asked = [...new Set(ids as string[])];
      for (let at = 0; at < asked.length; at += 16) await Promise.all(asked.slice(at, at + 16).map(look));
      sendJson(req, res, 200, { moved: found } satisfies MovedResponse);
      return;
    }

    if (parts.length === 1 && parts[0] === 'invite') {
      allow(req, 'POST');
      const device = requireDevice(req);
      // For another device of the same user, so nobody needs the owner for each new phone. Counted like pairing attempts.
      if (!inviteLimit.allow(device.id, now())) throw new HttpError(429, 'too-many-attempts');
      const { code, expiresAt } = pairing.createCode(DEVICE_INVITE_DAYS, device.userId);
      log(`"${device.name}" made an invite for another device of ${pairing.userOf(device).name}`);
      const origin = req.headers.origin;
      const app = config.appOrigins.find((allowed) => allowed === origin) ?? config.appOrigins[0] ?? '';
      sendJson(req, res, 200, { code, link: `${app}/#pair=${encodeURIComponent(config.publicBase)}&code=${code}`, expiresAt } satisfies InviteResponse);
      return;
    }

    if (parts.length === 2 && parts[0] === 'playlists' && parts[1] === 'shared') {
      allow(req, 'GET');
      const device = requireDevice(req);
      const names = new Map(pairing.listUsers().map((user) => [user.id, user]));
      const playlists = deps.playlists.sharedWith(device.userId).flatMap(({ ownerId, playlist }): SharedPlaylist[] => {
        const owner = names.get(ownerId);
        return owner ? [{ ...playlist, access: playlist.access === 'collaborative' ? 'collaborative' : 'public', owner: { id: owner.id, name: owner.name } }] : [];
      });
      sendJson(req, res, 200, { playlists } satisfies SharedPlaylistsResponse);
      return;
    }

    if (parts.length === 4 && parts[0] === 'playlists' && parts[1] === 'shared') {
      allow(req, 'PUT');
      const device = requireDevice(req);
      const owner = pairing.listUsers().find((user) => user.id === parts[2]);
      const tracks = acceptTracks((await readJsonBody(req, false, MAX_PLAYLISTS_BODY_BYTES)).tracks);
      if (!tracks) throw new HttpError(400, 'bad-request');
      const changed = owner && owner.id !== device.userId ? deps.playlists.replaceTracks(owner.id, decodeURIComponent(parts[3]), tracks) : 'missing';
      if (changed === 'missing' || !owner) throw new HttpError(404, 'not-found');
      if (changed === 'closed') throw new HttpError(403, 'not-collaborative');
      log(`"${changed.name}" (${owner.name}'s playlist) changed by ${pairing.userOf(device).name}: now ${changed.tracks.length} songs`);
      sendJson(req, res, 200, { ...changed, access: 'collaborative', owner: { id: owner.id, name: owner.name } } satisfies SharedPlaylist);
      return;
    }

    if (parts.length === 1 && parts[0] === 'playlists') {
      allow(req, 'GET', 'PUT');
      const device = requireDevice(req);
      if (req.method !== 'PUT') {
        sendJson(req, res, 200, deps.playlists.of(device.userId) satisfies PlaylistsResponse);
        return;
      }
      const body = await readJsonBody(req, false, MAX_PLAYLISTS_BODY_BYTES);
      const playlists = acceptPlaylists(body.playlists);
      if (typeof body.base !== 'number' || !Number.isSafeInteger(body.base) || body.base < 0 || !playlists) throw new HttpError(400, 'bad-request');
      const saved = deps.playlists.replace(device.userId, body.base, playlists);
      if (!saved) throw new HttpError(409, 'conflict');
      log(`playlists changed by "${device.name}": now ${saved.playlists.length}, version ${saved.version}`);
      sendJson(req, res, 200, saved satisfies PlaylistsResponse);
      return;
    }

    if (parts.length === 3 && parts[0] === 'tracks' && parts[2] === 'ticket') {
      allow(req, 'POST');
      requireDevice(req);
      const { fromSeconds = 0 }: TicketRequest = await readJsonBody(req, true);
      if (typeof fromSeconds !== 'number' || !Number.isFinite(fromSeconds) || fromSeconds < 0) throw new HttpError(400, 'bad-request');
      const track = await requireTrack(parts[1]);
      // For a FLAC file, the frame holding `fromSeconds`; any other file (or a damaged one) is played whole.
      const seek = await flacSeek(track.audioPath, fromSeconds);
      const exp = Math.floor(now() / 1000) + TICKET_LIFETIME_SECONDS;
      const sig = signTicket(secret, parts[1], exp);
      // `at` isn't signed: it only chooses where in an already permitted file to start, and the audio route checks it.
      const at = seek.at === null ? '' : `&at=${seek.at}`;
      sendJson(req, res, 200, {
        url: `${config.publicBase}tracks/${parts[1]}/audio?exp=${exp}&sig=${sig}${at}`,
        expiresAt: new Date(exp * 1000).toISOString(),
        exactSeek: seek.exactSeek,
        startSeconds: seek.startSeconds,
        totalSeconds: seek.totalSeconds,
      } satisfies TicketResponse);
      return;
    }

    if (parts.length === 4 && parts[0] === 'tracks' && parts[2] === 'lyrics') {
      allow(req, 'GET');
      requireDevice(req);
      const track = await requireTrack(parts[1]);
      // The same listing the browser shows (files over 5 MB already left out), so the index means the same file.
      const file = /^\d{1,4}$/.test(parts[3]) ? (await paths.lyricsOf(track))[Number(parts[3])] : undefined;
      if (!file) throw new HttpError(404, 'not-found');
      let text: Buffer;
      try {
        text = lyricsText(await readFile(file.path));
      } catch {
        throw new HttpError(404, 'not-found');
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': text.length, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : text);
      return;
    }

    if (parts.length === 3 && parts[0] === 'tracks' && parts[2] === 'audio') {
      allow(req, 'GET');
      // No token here: the signed ticket in the query string is the permission.
      const check = verifyTicket(secret, parts[1], url.searchParams.get('exp') ?? '', url.searchParams.get('sig') ?? '', Math.floor(now() / 1000));
      if (check !== 'ok') throw new HttpError(403, check === 'expired' ? 'expired-ticket' : 'bad-ticket');
      const atText = url.searchParams.get('at');
      if (atText !== null && !/^\d{1,15}$/.test(atText)) throw new HttpError(400, 'bad-request');
      const track = await requireTrack(parts[1]);
      const sent = await sendAudioFile(req, res, track.audioPath, atText === null ? undefined : Number(atText));
      if (sent === 'missing') throw new HttpError(404, 'not-found');
      if (sent === 'bad-start') throw new HttpError(400, 'bad-request');
      return;
    }

    throw new HttpError(404, 'not-found');
  }

  return (req, res) => {
    const origin = req.headers.origin;
    const allowed = originAllowed(origin, config.appOrigins);
    res.setHeader('Vary', 'Origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin!);
      res.setHeader('Access-Control-Expose-Headers', 'content-range, accept-ranges, content-length');
    }
    if (req.method === 'OPTIONS') {
      if (allowed) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, range');
        res.setHeader('Access-Control-Max-Age', '600');
        // Chrome asks this before a public page may call a server on a private address (a NAS reached over the LAN).
        if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      res.writeHead(204).end();
      return;
    }
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendError(req, res, error.status, error.code);
      } else {
        log(`request failed: ${String(error)}`);
        sendError(req, res, 500, 'server-error');
      }
    });
  };
}
