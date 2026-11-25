/** The request handler: every route of `src/shared/api.ts`, mounted at the path of `PUBLIC_BASE`. */
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ApiError, BrowseResponse, HealthResponse, LibraryResponse, MeResponse, NasTrack, PairResponse, TicketResponse,
} from '../../src/shared/api';
import { MAX_DEVICE_NAME_LENGTH, RateLimiter, TICKET_LIFETIME_SECONDS, signTicket, verifyTicket } from './auth';
import type { Device, PairingStore } from './auth';
import type { Config } from './config';
import { lyricsList } from './library';
import type { Library } from './library';
import { LibraryPaths, encodeTrackId, listFolder, stemOf } from './paths';
import type { FolderListing, ResolvedTrack } from './paths';
import { sendAudioFile } from './ranges';
import { VERSION } from './version';

export const MAX_JSON_BODY_BYTES = 16 * 1024;
export const PAIR_ATTEMPTS = 10;
export const PAIR_WINDOW_MS = 10 * 60 * 1000;

export interface AppDeps {
  config: Pick<Config, 'publicBase' | 'basePath' | 'serverName' | 'appOrigins' | 'roots'>;
  /** The tag-based library; empty, with `scannedAt` null, while the scan is off. */
  library: Pick<Library, 'tracks' | 'scannedAt'>;
  pairing: PairingStore;
  /** Signs tickets. */
  secret: Buffer;
  now?: () => number;
  log?: (message: string) => void;
}

/** An error answered as `{ error: code }` with `status`. */
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const byNameNumeric = (a: { name: string }, b: { name: string }): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

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

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_JSON_BODY_BYTES) throw new HttpError(413, 'too-large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) throw new HttpError(413, 'too-large');
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
  const pairLimit = new RateLimiter(PAIR_ATTEMPTS, PAIR_WINDOW_MS);
  const paths = new LibraryPaths(config.roots);

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

  async function browse(browsePath: string): Promise<BrowseResponse> {
    if (!browsePath) {
      const folders = config.roots.map((root) => ({ name: root.name, path: root.name }));
      return { serverName: config.serverName, path: '', parent: null, folders, tracks: [] };
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
    // No tags are read: a folder of any size costs one directory listing.
    const tracks: NasTrack[] = [...listing.audio].sort(byNameNumeric).map((file) => ({
      id: encodeTrackId(folder.root.name, [...folder.parts, file.name]),
      title: stemOf(file.name),
      artist: '',
      album: '',
      trackNumber: null,
      discNumber: null,
      durationSeconds: null,
      lyrics: lyricsList(file.lyrics),
    }));
    return {
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
      sendJson(req, res, 200, { token: paired.token, serverName: config.serverName, deviceName: paired.device.name } satisfies PairResponse);
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
      sendJson(req, res, 200, { serverName: config.serverName, deviceName: device.name } satisfies MeResponse);
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
      sendJson(req, res, 200, { serverName: config.serverName, scannedAt: library.scannedAt, tracks: library.tracks } satisfies LibraryResponse);
      return;
    }

    if (parts.length === 3 && parts[0] === 'tracks' && parts[2] === 'ticket') {
      allow(req, 'POST');
      requireDevice(req);
      await requireTrack(parts[1]);
      const exp = Math.floor(now() / 1000) + TICKET_LIFETIME_SECONDS;
      const sig = signTicket(secret, parts[1], exp);
      sendJson(req, res, 200, {
        url: `${config.publicBase}tracks/${parts[1]}/audio?exp=${exp}&sig=${sig}`,
        expiresAt: new Date(exp * 1000).toISOString(),
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
      const track = await requireTrack(parts[1]);
      if (!(await sendAudioFile(req, res, track.audioPath))) throw new HttpError(404, 'not-found');
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
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS');
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
