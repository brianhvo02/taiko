import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowseResponse, LibraryResponse, NasTrack, PairResponse, TicketResponse } from '../../src/shared/api';
import { createApp } from './app';
import { PlaylistStore } from './playlists';
import { ListeningStore } from './listening';
import { PairingStore, TICKET_LIFETIME_SECONDS, loadOrCreateSecret, signTicket } from './auth';
import type { LibraryRoot } from './config';
import { Library } from './library';
import { TagCache } from './tag-cache';
import { fakeFlac, removeDir, tempDir, writeFile } from './test-helpers';

const APP_ORIGIN = 'https://player.example.com';
const LRC = '[00:01.00]紙の灯籠\n[00:05.00]Paper lanterns\n';

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  json: <T = Record<string, unknown>>() => T;
}

interface Running {
  server: Server;
  base: string;
  pairing: PairingStore;
  secret: Buffer;
  call: (method: string, route: string, options?: { token?: string; headers?: Record<string, string>; body?: string | object }) => Promise<Reply>;
}

let dir: string;
let clock = Date.parse('2026-03-01T12:00:00Z');
const flac = fakeFlac(['TITLE=Paper Lanterns', 'ARTIST=Midori Vale', 'ALBUM=Night Market', 'TRACKNUMBER=3'], 5000);
const servers: Server[] = [];

const id = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

/** `scan: false` is the server with LIBRARY_SCAN off: the library is never scanned. */
async function start(basePath: string, options: { scan?: boolean; roots?: LibraryRoot[] } = {}): Promise<Running> {
  const roots = options.roots ?? [{ name: 'main', dir: path.join(dir, 'music') }];
  const tags = new TagCache();
  const library = new Library(options.scan ?? true ? roots : [], tags);
  library.scan();
  await library.idle();
  const data = path.join(dir, `data${servers.length}`);
  const pairing = new PairingStore(data, () => clock);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}${basePath}`;
  const secret = loadOrCreateSecret(data);
  server.on('request', createApp({
    config: { publicBase: base, basePath, serverName: 'Test NAS', appOrigins: [APP_ORIGIN], roots },
    library,
    tags,
    pairing,
    playlists: new PlaylistStore(data),
    listening: new ListeningStore(data, () => clock),
    secret,
    now: () => clock,
  }));

  const call: Running['call'] = (method, route, options = {}) => new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = request(route.startsWith('http') ? route : base + route, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const all = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: all, json: () => JSON.parse(all.toString('utf8')) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
  return { server, base, pairing, secret, call };
}

async function pair(running: Running, deviceName = 'Kitchen tablet'): Promise<string> {
  const reply = await running.call('POST', 'pair', { body: { code: running.pairing.createCode().code, deviceName } });
  expect(reply.status).toBe(200);
  return reply.json<PairResponse>().token;
}

let app: Running;

beforeAll(async () => {
  dir = tempDir();
  writeFile(path.join(dir, 'music', 'Night Market', '03 Paper Lanterns.flac'), flac);
  writeFile(path.join(dir, 'music', 'Night Market', '03 Paper Lanterns.lrc'), LRC);
  writeFile(path.join(dir, 'music', 'Night Market', '03 Paper Lanterns.ja.ttml'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<tt>灯籠</tt>', 'utf16le')]));
  writeFile(path.join(dir, 'music', 'Loose Song.mp3'), Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  app = await start('/api/');
});

afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  removeDir(dir);
});

describe('the whole flow', () => {
  it('pairs, lists, plays, reads lyrics, and forgets the device', async () => {
    const health = await app.call('GET', 'health');
    expect(health.status).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, name: 'taiko-server' });

    // pair
    const { code } = app.pairing.createCode();
    const paired = await app.call('POST', 'pair', { body: { code, deviceName: '  Kitchen tablet ' } });
    expect(paired.status).toBe(200);
    const { token, ...rest } = paired.json<PairResponse>();
    expect(rest).toEqual({ serverName: 'Test NAS', deviceName: 'Kitchen tablet', user: { id: 'owner', name: 'Owner', owner: true } });
    expect((await app.call('POST', 'pair', { body: { code, deviceName: 'Again' } })).status).toBe(403);

    // me
    const me = await app.call('GET', 'me', { token });
    expect(me.status).toBe(200);
    expect(me.json()).toEqual({ serverName: 'Test NAS', deviceName: 'Kitchen tablet', user: { id: 'owner', name: 'Owner', owner: true } });

    // library
    const library = await app.call('GET', 'library', { token });
    expect(library.status).toBe(200);
    const list = library.json<LibraryResponse>();
    expect(list.serverName).toBe('Test NAS');
    expect(typeof list.scannedAt).toBe('string');
    expect(list).toMatchObject({ enabled: true, scanning: false });
    // The folder of the tagged song, then the root itself, which holds a song of its own and has no artist.
    expect(list.albums.map((album) => [album.path, album.title, album.artist, album.trackCount])).toEqual([
      ['main/Night Market', 'Night Market', 'Midori Vale', 1],
      ['main', 'main', '', 1],
    ]);
    const folder = (await app.call('GET', `browse?path=${encodeURIComponent(list.albums[0].path)}`, { token })).json<BrowseResponse>();
    const track = folder.tracks[0];
    expect(track.id).toBe(id('main/Night Market/03 Paper Lanterns.flac'));
    expect(track).toMatchObject({ artist: 'Midori Vale', album: 'Night Market', trackNumber: 3, durationSeconds: 10 });
    expect(track.lyrics).toEqual([
      { index: 0, name: '03 Paper Lanterns.ja.ttml', format: 'ttml' },
      { index: 1, name: '03 Paper Lanterns.lrc', format: 'lrc' },
    ]);
    expect(JSON.stringify(list)).not.toContain(dir.replaceAll('\\', '\\\\'));

    // ticket
    const ticketReply = await app.call('POST', `tracks/${track.id}/ticket`, { token });
    expect(ticketReply.status).toBe(200);
    const ticket = ticketReply.json<TicketResponse>();
    expect(ticket.url.startsWith(`${app.base}tracks/${track.id}/audio?exp=`)).toBe(true);
    expect(Date.parse(ticket.expiresAt)).toBe(Math.floor(clock / 1000) * 1000 + TICKET_LIFETIME_SECONDS * 1000);

    // audio, with no token
    const whole = await app.call('GET', ticket.url);
    expect(whole.status).toBe(200);
    expect(whole.headers['content-type']).toBe('audio/flac');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['content-length']).toBe(String(flac.length));
    expect(whole.headers['cache-control']).toBe('private, max-age=3600');
    expect(whole.body.equals(flac)).toBe(true);

    const part = await app.call('GET', ticket.url, { headers: { range: 'bytes=100-299' } });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 100-299/${flac.length}`);
    expect(part.headers['content-length']).toBe('200');
    expect(part.body.equals(flac.subarray(100, 300))).toBe(true);

    const tail = await app.call('GET', ticket.url, { headers: { range: 'bytes=-50' } });
    expect(tail.status).toBe(206);
    expect(tail.body.equals(flac.subarray(flac.length - 50))).toBe(true);

    const open = await app.call('GET', ticket.url, { headers: { range: `bytes=${flac.length - 10}-` } });
    expect(open.headers['content-range']).toBe(`bytes ${flac.length - 10}-${flac.length - 1}/${flac.length}`);
    expect(open.body.equals(flac.subarray(flac.length - 10))).toBe(true);

    const past = await app.call('GET', ticket.url, { headers: { range: `bytes=${flac.length}-` } });
    expect(past.status).toBe(416);
    expect(past.headers['content-range']).toBe(`bytes */${flac.length}`);

    const head = await app.call('HEAD', ticket.url, { headers: { range: 'bytes=0-9' } });
    expect(head.status).toBe(206);
    expect(head.headers['content-length']).toBe('10');
    expect(head.body).toHaveLength(0);

    // lyrics
    const lrc = await app.call('GET', `tracks/${track.id}/lyrics/1`, { token });
    expect(lrc.status).toBe(200);
    expect(lrc.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(lrc.body.toString('utf8')).toBe(LRC);
    const ttml = await app.call('GET', `tracks/${track.id}/lyrics/0`, { token });
    expect(ttml.body.toString('utf8')).toBe('<tt>灯籠</tt>'); // stored as UTF-16, sent as UTF-8
    expect((await app.call('GET', `tracks/${track.id}/lyrics/2`, { token })).status).toBe(404);
    expect((await app.call('GET', `tracks/${track.id}/lyrics/-1`, { token })).status).toBe(404);
    expect((await app.call('GET', `tracks/${track.id}/lyrics/0`)).status).toBe(401);

    // forget this device
    const gone = await app.call('DELETE', 'me', { token });
    expect(gone.status).toBe(204);
    expect(gone.body).toHaveLength(0);
    const after = await app.call('GET', 'me', { token });
    expect(after.status).toBe(401);
    expect(after.json()).toEqual({ error: 'unauthorized' });
    expect((await app.call('GET', 'library', { token })).status).toBe(401);
  });
});

describe('refusals', () => {
  let token: string;
  let track: NasTrack;

  beforeAll(async () => {
    token = await pair(app, 'Laptop');
    track = (await app.call('GET', `browse?path=${encodeURIComponent('main/Night Market')}`, { token })).json<BrowseResponse>().tracks[0];
  });

  it('answers 403 bad-code for a wrong code', async () => {
    const reply = await app.call('POST', 'pair', { body: { code: 'AAAA-BBBB-CCCC', deviceName: 'Guess' } });
    expect(reply.status).toBe(403);
    expect(reply.json()).toEqual({ error: 'bad-code' });
  });

  it('answers 403 bad-code for an expired code', async () => {
    const { code } = app.pairing.createCode(1);
    clock += 25 * 60 * 60 * 1000;
    expect((await app.call('POST', 'pair', { body: { code, deviceName: 'Late' } })).status).toBe(403);
  });

  it('answers 400 for a malformed pairing request', async () => {
    const { code } = app.pairing.createCode();
    for (const body of ['{ not json', '[]', { code }, { code, deviceName: '   ' }, { code, deviceName: 'x'.repeat(65) }, { code: 5, deviceName: 'Phone' }]) {
      const reply = await app.call('POST', 'pair', { body });
      expect(reply.status).toBe(400);
      expect(reply.json()).toEqual({ error: 'bad-request' });
    }
    expect((await app.call('POST', 'pair', { body: { code, deviceName: 'x'.repeat(20_000) } })).status).toBe(413);
    // None of those used the code up.
    expect((await app.call('POST', 'pair', { body: { code, deviceName: 'Phone' } })).status).toBe(200);
  });

  it('answers 401 without a token or with a wrong one', async () => {
    for (const route of ['me', 'library', `tracks/${track.id}/lyrics/0`]) {
      expect((await app.call('GET', route)).status).toBe(401);
      expect((await app.call('GET', route, { token: 'x'.repeat(43) })).status).toBe(401);
      expect((await app.call('GET', route, { headers: { authorization: `Basic ${token}` } })).status).toBe(401);
    }
    expect((await app.call('POST', `tracks/${track.id}/ticket`)).status).toBe(401);
    expect((await app.call('DELETE', 'me')).status).toBe(401);
    expect((await app.call('GET', 'me', { token })).status).toBe(200);
  });

  it('answers 403 for a tampered ticket', async () => {
    const ticket = (await app.call('POST', `tracks/${track.id}/ticket`, { token })).json<TicketResponse>();
    const url = new URL(ticket.url);
    const exp = url.searchParams.get('exp')!;
    const sig = url.searchParams.get('sig')!;
    const audio = (id: string, query: string): Promise<Reply> => app.call('GET', `tracks/${id}/audio${query}`);
    const other = (await app.call('GET', 'browse?path=main', { token })).json<BrowseResponse>().tracks[0];

    expect((await audio(track.id, `?exp=${exp}&sig=${sig}`)).status).toBe(200);
    const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
    for (const reply of [
      await audio(track.id, `?exp=${exp}&sig=${flipped}`),
      await audio(track.id, `?exp=${Number(exp) + 3600}&sig=${sig}`),
      await audio(other.id, `?exp=${exp}&sig=${sig}`),
      await audio(track.id, `?exp=${exp}`),
      await audio(track.id, ''),
    ]) {
      expect(reply.status).toBe(403);
      expect(reply.json()).toEqual({ error: 'bad-ticket' });
    }
  });

  it('answers 403 for an expired ticket', async () => {
    const ticket = (await app.call('POST', `tracks/${track.id}/ticket`, { token })).json<TicketResponse>();
    clock += (TICKET_LIFETIME_SECONDS - 5) * 1000;
    expect((await app.call('GET', ticket.url)).status).toBe(200);
    clock += 10_000;
    const reply = await app.call('GET', ticket.url);
    expect(reply.status).toBe(403);
    expect(reply.json()).toEqual({ error: 'expired-ticket' });
  });

  it('answers 404 for an unknown track or route', async () => {
    for (const reply of [
      await app.call('POST', 'tracks/0123456789abcdef/ticket', { token }),
      await app.call('POST', `tracks/${id('main/Night Market/Missing.flac')}/ticket`, { token }),
      await app.call('POST', `tracks/${id('main/Night Market/03 Paper Lanterns.lrc')}/ticket`, { token }),
      await app.call('POST', `tracks/${id('main/../data0/secret.key')}/ticket`, { token }),
      await app.call('GET', `tracks/${id('main/../music/Loose Song.mp3')}/lyrics/0`, { token }),
      await app.call('POST', 'tracks/..%2F..%2Fsecret.key/ticket', { token }),
      await app.call('GET', 'tracks/0123456789abcdef/lyrics/0', { token }),
      await app.call('GET', 'nothing', { token }),
      await app.call('GET', `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/health`),
      await app.call('GET', `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/`),
    ]) {
      expect(reply.status).toBe(404);
      expect(reply.json()).toEqual({ error: 'not-found' });
    }
  });

  it('answers 405 for the wrong method', async () => {
    expect((await app.call('GET', 'pair')).status).toBe(405);
    expect((await app.call('POST', 'library', { token })).status).toBe(405);
  });
});

describe('CORS', () => {
  it('reflects an allowed origin and exposes the range headers', async () => {
    for (const origin of [APP_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost']) {
      const reply = await app.call('GET', 'health', { headers: { origin } });
      expect(reply.headers['access-control-allow-origin']).toBe(origin);
      expect(reply.headers['access-control-expose-headers']).toBe('content-range, accept-ranges, content-length');
      expect(reply.headers.vary).toBe('Origin');
    }
  });

  it('gives a disallowed origin no permission', async () => {
    for (const origin of ['https://evil.example.com', 'https://localhost:5173', 'http://localhost.evil.example.com', 'http://player.example.com', 'null']) {
      const reply = await app.call('GET', 'health', { headers: { origin } });
      expect(reply.status).toBe(200);
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
      expect(reply.headers.vary).toBe('Origin');
      const preflight = await app.call('OPTIONS', 'library', { headers: { origin, 'access-control-request-method': 'GET' } });
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
      expect(preflight.headers['access-control-allow-methods']).toBeUndefined();
    }
  });

  it('answers a preflight with 204', async () => {
    const reply = await app.call('OPTIONS', 'library', {
      headers: { origin: APP_ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(reply.status).toBe(204);
    expect(reply.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(reply.headers['access-control-allow-methods']).toBe('GET, HEAD, POST, PUT, DELETE, OPTIONS');
    expect(reply.headers['access-control-allow-headers']).toBe('authorization, content-type, range');
    expect(reply.body).toHaveLength(0);
  });
});

describe('another mount point and the pairing limit', () => {
  it('serves under the path of PUBLIC_BASE and limits pairing attempts', async () => {
    const other = await start('/taiko/api/');
    expect(other.base.endsWith('/taiko/api/')).toBe(true);
    expect((await other.call('GET', 'health')).status).toBe(200);
    const token = await pair(other);
    const { tracks } = (await other.call('GET', 'browse?path=main', { token })).json<BrowseResponse>();
    const ticket = (await other.call('POST', `tracks/${tracks[0].id}/ticket`, { token })).json<TicketResponse>();
    expect(ticket.url).toContain('/taiko/api/tracks/');
    expect((await other.call('GET', ticket.url)).status).toBe(200);
    expect((await other.call('GET', other.base.replace('/taiko/api/', '/api/health'))).status).toBe(404);

    // One attempt is used above; nine more are allowed in the window, then none until it passes.
    for (let i = 0; i < 9; i++) {
      expect((await other.call('POST', 'pair', { body: { code: 'AAAA-BBBB-CCCC', deviceName: 'Guess' } })).status).toBe(403);
    }
    const { code } = other.pairing.createCode();
    const limited = await other.call('POST', 'pair', { body: { code, deviceName: 'Phone' } });
    expect(limited.status).toBe(429);
    expect(limited.json()).toEqual({ error: 'too-many-attempts' });
    clock += 10 * 60 * 1000;
    expect((await other.call('POST', 'pair', { body: { code, deviceName: 'Phone' } })).status).toBe(200);
  });
});

describe('the folder browser, with the library scan off', () => {
  let off: Running;
  let token: string;
  const song = fakeFlac(['TITLE=Slack Water', 'ARTIST=Tin Harbor'], 4000);
  const browse = (browsePath?: string, auth: string | undefined = token): Promise<Reply> =>
    off.call('GET', browsePath === undefined ? 'browse' : `browse?path=${encodeURIComponent(browsePath)}`, { token: auth });

  beforeAll(async () => {
    const shelf = path.join(dir, 'shelf');
    const album = path.join(shelf, 'Tin Harbor', 'Low Tide');
    writeFile(path.join(album, '2 - b.flac'), song);
    writeFile(path.join(album, '10 - a.flac'), song);
    writeFile(path.join(album, '1 - c.MP3'), Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    writeFile(path.join(album, '10 - a.lrc'), LRC);
    writeFile(path.join(album, '10 - a.ja.ttml'), '<tt>干潮</tt>');
    writeFile(path.join(album, '1 - c.huge.lrc'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x20));
    writeFile(path.join(album, 'cover.jpg'), 'a picture');
    writeFile(path.join(album, '.2 - b.flac'), song);
    writeFile(path.join(album, 'Disc 10', 'x.flac'), song);
    writeFile(path.join(album, 'Disc 2', 'x.flac'), song);
    writeFile(path.join(album, 'disc 1', 'x.flac'), song);
    writeFile(path.join(album, '.hidden', 'x.flac'), song);
    writeFile(path.join(album, '@eaDir', 'x.flac'), song);
    off = await start('/api/', { scan: false, roots: [{ name: 'Shelf', dir: shelf }, { name: 'main', dir: path.join(dir, 'music') }] });
    token = await pair(off);
  });

  it('answers an empty library', async () => {
    const reply = await off.call('GET', 'library', { token });
    expect(reply.status).toBe(200);
    expect(reply.json()).toEqual({ serverName: 'Test NAS', enabled: false, scanning: false, scannedAt: null, albums: [] });
    expect((await off.call('GET', 'library/search?q=tin', { token })).json()).toEqual({ tracks: [] });
    expect((await off.call('POST', 'library/scan', { token })).json()).toEqual({ started: false });
  });

  it('lists the roots, in the order configured, for an empty or missing path', async () => {
    const roots = { serverName: 'Test NAS', path: '', parent: null, folders: [{ name: 'Shelf', path: 'Shelf' }, { name: 'main', path: 'main' }], tracks: [], cover: null };
    for (const reply of [await browse(), await browse('')]) {
      expect(reply.status).toBe(200);
      expect(reply.json()).toEqual(roots);
    }
  });

  it('lists a root and a nested folder, with their parents', async () => {
    expect((await browse('Shelf')).json()).toEqual({
      serverName: 'Test NAS', path: 'Shelf', parent: '', folders: [{ name: 'Tin Harbor', path: 'Shelf/Tin Harbor' }], tracks: [], cover: null,
    });
    const artist = (await browse('Shelf/Tin Harbor')).json<BrowseResponse>();
    expect(artist).toMatchObject({ path: 'Shelf/Tin Harbor', parent: 'Shelf', folders: [{ name: 'Low Tide', path: 'Shelf/Tin Harbor/Low Tide' }] });

    const album = (await browse('Shelf/Tin Harbor/Low Tide')).json<BrowseResponse>();
    expect(album.path).toBe('Shelf/Tin Harbor/Low Tide');
    expect(album.parent).toBe('Shelf/Tin Harbor');
    // Numbers in order by file name, named by their tags, and nothing the server never lists.
    expect(album.folders).toEqual([
      { name: 'disc 1', path: 'Shelf/Tin Harbor/Low Tide/disc 1' },
      { name: 'Disc 2', path: 'Shelf/Tin Harbor/Low Tide/Disc 2' },
      { name: 'Disc 10', path: 'Shelf/Tin Harbor/Low Tide/Disc 10' },
    ]);
    expect(album.tracks).toEqual([
      { id: id('Shelf/Tin Harbor/Low Tide/1 - c.MP3'), title: '1 - c', artist: '', album: '', trackNumber: null, discNumber: null, durationSeconds: null, lyrics: [] },
      { id: id('Shelf/Tin Harbor/Low Tide/2 - b.flac'), title: 'Slack Water', artist: 'Tin Harbor', album: '', trackNumber: null, discNumber: null, durationSeconds: 10, sampleRate: 44100, bitsPerSample: 16, lyrics: [] },
      {
        id: id('Shelf/Tin Harbor/Low Tide/10 - a.flac'), title: 'Slack Water', artist: 'Tin Harbor', album: '', trackNumber: null, discNumber: null, durationSeconds: 10, sampleRate: 44100, bitsPerSample: 16,
        lyrics: [{ index: 0, name: '10 - a.ja.ttml', format: 'ttml' }, { index: 1, name: '10 - a.lrc', format: 'lrc' }],
      },
    ]);
  });

  it('answers 404 for a path that is not a folder inside a root', async () => {
    for (const browsePath of [
      'Nope', 'Shelf/Nope', 'Shelf/Tin Harbor/Low Tide/2 - b.flac', 'Shelf/..', 'Shelf/../music', 'Shelf/../data0', 'Shelf/Tin Harbor/../..',
      'Shelf/', '/Shelf', 'Shelf//Tin Harbor', 'Shelf\\Tin Harbor', 'Shelf/Tin Harbor/Low Tide/.hidden', 'Shelf/Tin Harbor/Low Tide/@eaDir',
      'shelf', dir, path.join(dir, 'shelf'), '..', '.', 'Shelf/%2e%2e/music',
    ]) {
      const reply = await browse(browsePath);
      expect(reply.status).toBe(404);
      expect(reply.json()).toEqual({ error: 'not-found' });
    }
  });

  it('answers 401 without a token', async () => {
    for (const reply of [await browse(undefined, ''), await browse('Shelf', ''), await browse('Shelf', 'x'.repeat(43))]) {
      expect(reply.status).toBe(401);
      expect(reply.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('plays a file and reads its lyrics though no scan ever listed it', async () => {
    const album = (await browse('Shelf/Tin Harbor/Low Tide')).json<BrowseResponse>();
    const track = album.tracks[2];

    const ticketReply = await off.call('POST', `tracks/${track.id}/ticket`, { token });
    expect(ticketReply.status).toBe(200);
    const ticket = ticketReply.json<TicketResponse>();
    expect(ticket.url.startsWith(`${off.base}tracks/${track.id}/audio?exp=`)).toBe(true);

    const part = await off.call('GET', ticket.url, { headers: { range: 'bytes=200-1199' } });
    expect(part.status).toBe(206);
    expect(part.headers['content-type']).toBe('audio/flac');
    expect(part.headers['content-range']).toBe(`bytes 200-1199/${song.length}`);
    expect(part.body.equals(song.subarray(200, 1200))).toBe(true);
    expect((await off.call('GET', ticket.url)).body.equals(song)).toBe(true);

    // The index is the one the browse listing gave.
    const lrc = await off.call('GET', `tracks/${track.id}/lyrics/1`, { token });
    expect(lrc.status).toBe(200);
    expect(lrc.body.toString('utf8')).toBe(LRC);
    expect((await off.call('GET', `tracks/${track.id}/lyrics/0`, { token })).body.toString('utf8')).toBe('<tt>干潮</tt>');
    expect((await off.call('GET', `tracks/${track.id}/lyrics/2`, { token })).status).toBe(404);
    // The oversized file beside "1 - c" is neither listed nor served.
    expect((await off.call('GET', `tracks/${album.tracks[0].id}/lyrics/0`, { token })).status).toBe(404);
    expect((await off.call('GET', `tracks/${track.id}/lyrics/0`)).status).toBe(401);
  });

  it('answers 404 for an id that leads anywhere else, even with a valid signature', async () => {
    const exp = Math.floor(clock / 1000) + 600;
    for (const text of [
      'Shelf/../data0/secret.key', 'Shelf/../music/Loose Song.mp3', 'Shelf/Tin Harbor/Low Tide/../Low Tide/2 - b.flac',
      'Shelf/Tin Harbor/Low Tide/cover.jpg', 'Shelf/Tin Harbor/Low Tide/10 - a.lrc', 'Shelf/Tin Harbor/Low Tide/.2 - b.flac',
      'Shelf/Tin Harbor/Low Tide/.hidden/x.flac', 'Shelf/Tin Harbor/Low Tide', 'Shelf\\Tin Harbor\\Low Tide\\2 - b.flac',
      'Nope/2 - b.flac', path.join(dir, 'shelf', 'Tin Harbor', 'Low Tide', '2 - b.flac'), 'Shelf/Tin Harbor/Low Tide/3 - missing.flac',
    ]) {
      const ticket = await off.call('POST', `tracks/${id(text)}/ticket`, { token });
      expect(ticket.status).toBe(404);
      // Signed here with the server's own secret, as if a ticket for it had been issued.
      const audio = await off.call('GET', `tracks/${id(text)}/audio?exp=${exp}&sig=${signTicket(off.secret, id(text), exp)}`);
      expect(audio.status).toBe(404);
      expect(audio.json()).toEqual({ error: 'not-found' });
    }
    const good = id('Shelf/Tin Harbor/Low Tide/2 - b.flac');
    expect((await off.call('GET', `tracks/${good}/audio?exp=${exp}&sig=${signTicket(off.secret, good, exp)}`)).status).toBe(200);
    expect((await off.call('GET', `tracks/${good}/audio?exp=${exp}&sig=${signTicket(off.secret, id('Shelf/Tin Harbor/Low Tide/10 - a.flac'), exp)}`)).status).toBe(403);
  });
});

describe('users and their playlists', () => {
  const song = (name: string) => ({ id: name, title: name, artist: 'Midori Vale', album: '', trackNumber: null, discNumber: null, durationSeconds: 10 });
  /** Pairs a device for a user, as an invite made for them would. */
  const pairFor = async (running: Running, userId: string, deviceName: string): Promise<string> => {
    const reply = await running.call('POST', 'pair', { body: { code: running.pairing.createCode(1, userId).code, deviceName } });
    expect(reply.status).toBe(200);
    return reply.json<PairResponse>().token;
  };

  it('keeps one set for all of a user\'s devices, and refuses a change made from an older version', async () => {
    const shared = await start('/api/');
    const phone = await pair(shared, 'Phone');
    const tablet = await pair(shared, 'Tablet');
    expect((await shared.call('GET', 'playlists')).status).toBe(401);
    expect((await shared.call('GET', 'playlists', { token: phone })).json()).toEqual({ version: 0, playlists: [] });

    const first = [{ id: 'p1', name: 'Evening', tracks: [song('a'), song('b')] }];
    const saved = await shared.call('PUT', 'playlists', { token: phone, body: { base: 0, playlists: first } });
    expect(saved.status).toBe(200);
    expect(saved.json()).toEqual({ version: 1, playlists: first });
    // The user's other device sees it, and what it sends from the version it saw is kept.
    expect((await shared.call('GET', 'playlists', { token: tablet })).json()).toEqual({ version: 1, playlists: first });
    const second = [...first, { id: 'p2', name: 'Morning', tracks: [] }];
    expect((await shared.call('PUT', 'playlists', { token: tablet, body: { base: 1, playlists: second } })).json()).toEqual({ version: 2, playlists: second });

    // The phone, still at version 1, is told to look again; nothing is changed.
    const late = await shared.call('PUT', 'playlists', { token: phone, body: { base: 1, playlists: [] } });
    expect(late.status).toBe(409);
    expect(late.json()).toEqual({ error: 'conflict' });
    expect((await shared.call('GET', 'playlists', { token: phone })).json()).toEqual({ version: 2, playlists: second });
  });

  it('stores playlists only, and refuses what is not a set of them', async () => {
    const shared = await start('/api/');
    const token = await pair(shared);
    const extra = await shared.call('PUT', 'playlists', { token, body: { base: 0, playlists: [{ id: 'p1', name: 'Evening', owner: 'x', access: 'everyone', tracks: [{ ...song('a'), cover: 'http://elsewhere/' }] }] } });
    expect(extra.json()).toEqual({ version: 1, playlists: [{ id: 'p1', name: 'Evening', tracks: [song('a')] }] });
    for (const body of [{ playlists: [] }, { base: -1, playlists: [] }, { base: 1, playlists: 'all' }, { base: 1, playlists: [{ id: 'p1' }] }, { base: 1, playlists: [{ id: 'p', name: 'n'.repeat(81), tracks: [] }] }]) {
      expect((await shared.call('PUT', 'playlists', { token, body })).status).toBe(400);
    }
    expect((await shared.call('POST', 'playlists', { token, body: {} })).status).toBe(405);
    expect((await shared.call('GET', 'playlists', { token })).json()).toMatchObject({ version: 1 });
  });

  it('gives each user their own playlists, and shows the others only what is public or collaborative', async () => {
    const home = await start('/api/');
    const aki = home.pairing.addUser('Aki')!;
    const owner = await pair(home, 'Owner phone');
    const friend = await pairFor(home, aki.id, 'Aki phone');
    expect((await home.call('GET', 'me', { token: friend })).json()).toEqual({ serverName: 'Test NAS', deviceName: 'Aki phone', user: { id: aki.id, name: 'Aki', owner: false } });

    const mine = [
      { id: 'secret', name: 'Just mine', tracks: [song('a')] },
      { id: 'open', name: 'For everyone', tracks: [song('b')], access: 'public' },
      { id: 'ours', name: 'Road trip', tracks: [song('c')], access: 'collaborative' },
    ];
    expect((await home.call('PUT', 'playlists', { token: owner, body: { base: 0, playlists: mine } })).status).toBe(200);
    // Aki's own set is empty, and is theirs alone.
    expect((await home.call('GET', 'playlists', { token: friend })).json()).toEqual({ version: 0, playlists: [] });
    expect((await home.call('PUT', 'playlists', { token: friend, body: { base: 0, playlists: [{ id: 'aki', name: 'Aki only', tracks: [] }] } })).status).toBe(200);
    expect((await home.call('GET', 'playlists', { token: owner })).json<{ playlists: unknown[] }>().playlists).toHaveLength(3);

    // What Aki is shown of the owner's: not the private one, and whose each is.
    const by = { id: 'owner', name: 'Owner' };
    expect((await home.call('GET', 'playlists/shared', { token: friend })).json()).toEqual({
      playlists: [{ ...mine[1], owner: by }, { ...mine[2], owner: by }],
    });
    expect((await home.call('GET', 'playlists/shared', { token: owner })).json()).toEqual({ playlists: [] });

    // Aki may change the songs of the collaborative one, and of no other.
    const changed = await home.call('PUT', 'playlists/shared/owner/ours', { token: friend, body: { tracks: [song('c'), song('d')] } });
    expect(changed.status).toBe(200);
    expect(changed.json()).toEqual({ ...mine[2], tracks: [song('c'), song('d')], owner: by });
    expect((await home.call('PUT', 'playlists/shared/owner/open', { token: friend, body: { tracks: [] } })).json()).toEqual({ error: 'not-collaborative' });
    expect((await home.call('PUT', 'playlists/shared/owner/secret', { token: friend, body: { tracks: [] } })).status).toBe(404);
    expect((await home.call('PUT', 'playlists/shared/nobody/ours', { token: friend, body: { tracks: [] } })).status).toBe(404);
    expect((await home.call('PUT', 'playlists/shared/owner/ours', { token: friend, body: { tracks: 'all' } })).status).toBe(400);
    // The owner's devices take the change up as a newer version of their own set.
    const now = (await home.call('GET', 'playlists', { token: owner })).json<{ version: number; playlists: { id: string; tracks: unknown[] }[] }>();
    expect(now.version).toBe(2);
    expect(now.playlists.find((playlist) => playlist.id === 'ours')?.tracks).toHaveLength(2);
  });

  it('lets a device invite another device of its own user, a few times', async () => {
    const home = await start('/api/');
    const aki = home.pairing.addUser('Aki')!;
    const phone = await pairFor(home, aki.id, 'Aki phone');
    const invite = await home.call('POST', 'invite', { token: phone, headers: { origin: APP_ORIGIN } });
    expect(invite.status).toBe(200);
    const made = invite.json<{ code: string; link: string; expiresAt: string }>();
    expect(made.link).toBe(`${APP_ORIGIN}/#pair=${encodeURIComponent(home.base)}&code=${made.code}`);
    const tablet = (await home.call('POST', 'pair', { body: { code: made.code, deviceName: 'Aki tablet' } })).json<PairResponse>().token;
    expect((await home.call('GET', 'me', { token: tablet })).json<{ user: { name: string } }>().user.name).toBe('Aki');
    expect((await home.call('POST', 'invite')).status).toBe(401);
    for (let i = 0; i < 4; i++) expect((await home.call('POST', 'invite', { token: phone })).status).toBe(200);
    expect((await home.call('POST', 'invite', { token: phone })).status).toBe(429);
  });

  it('removes a user with their devices; what they shared passes to the owner', async () => {
    const home = await start('/api/');
    const aki = home.pairing.addUser('Aki')!;
    expect(home.pairing.addUser(' aki ')).toBeNull();
    expect(home.pairing.addUser('')).toBeNull();
    const friend = await pairFor(home, aki.id, 'Aki phone');
    await home.call('PUT', 'playlists', { token: friend, body: { base: 0, playlists: [{ id: 'a1', name: 'Private', tracks: [] }, { id: 'a2', name: 'Shared', tracks: [song('a')], access: 'public' }] } });
    const store = new PlaylistStore(path.join(dir, `data${servers.length - 1}`));
    expect(store.removeUser(aki.id)).toBe(1);
    expect(home.pairing.removeUser(aki.id)).toBe(1);
    expect(home.pairing.removeUser('owner')).toBeNull();
    expect((await home.call('GET', 'me', { token: friend })).status).toBe(401);
    const owner = await pair(home, 'Owner phone');
    expect((await home.call('GET', 'playlists', { token: owner })).json()).toEqual({ version: 1, playlists: [{ id: 'a2', name: 'Shared', tracks: [song('a')], access: 'public' }] });
  });

  it('gives a store from before there were users to the owner', async () => {
    const home = await start('/api/');
    const data = path.join(dir, `data${servers.length - 1}`);
    const token = await pair(home, 'Old phone');
    // As the files were: devices and codes with no user, and one set of playlists for everyone.
    const pairingFile = JSON.parse(readFileSync(path.join(data, 'pairing.json'), 'utf8')) as { users?: unknown; devices: { userId?: string }[] };
    delete pairingFile.users;
    for (const device of pairingFile.devices) delete device.userId;
    writeFile(path.join(data, 'pairing.json'), JSON.stringify(pairingFile));
    writeFile(path.join(data, 'playlists.json'), JSON.stringify({ version: 4, playlists: [{ id: 'old', name: 'From before', tracks: [song('a')] }] }));

    expect((await home.call('GET', 'me', { token })).json<{ user: unknown }>().user).toEqual({ id: 'owner', name: 'Owner', owner: true });
    expect((await home.call('GET', 'playlists', { token })).json()).toEqual({ version: 4, playlists: [{ id: 'old', name: 'From before', tracks: [song('a')] }] });
    expect(home.pairing.renameUser('owner', 'Midori')).toBe(true);
    expect((await home.call('GET', 'me', { token })).json<{ user: { name: string } }>().user.name).toBe('Midori');
  });
});

describe('songs that moved when an album was replaced', () => {
  it('says where a song that is gone went, from the record in the new root, and nothing about a song still there', async () => {
    const old = path.join(dir, 'moved-old');
    const fresh = path.join(dir, 'moved-new');
    writeFile(path.join(old, 'Tin Harbor', 'Low Tide', '01 still here.flac'), flac);
    writeFile(path.join(fresh, 'Tin Harbor', '[2024] Low Tide', '01. Still Here.flac'), flac);
    writeFile(path.join(fresh, 'Tin Harbor', '[2024] Low Tide', '02. Shoals.flac'), flac);
    const line = (oldPath: string, newPath: string, event = 'replaced') => JSON.stringify({ event, oldRoot: 'Old', oldPath, newPath, appleSongId: '1', date: '2026-11-25' });
    writeFile(path.join(fresh, '.ringobushi', 'replaced.jsonl'), [
      line('Tin Harbor/Low Tide/01 still here.flac', 'Tin Harbor/[2024] Low Tide/01. Still Here.flac'),
      line('Tin Harbor/Low Tide/02 shoals.flac', 'Tin Harbor/[2024] Low Tide/nowhere.flac'),
      'not json',
      line('Tin Harbor/Low Tide/02 shoals.flac', 'Tin Harbor/[2024] Low Tide/02. Shoals.flac'),
      line('Tin Harbor/Low Tide/03 bonus.flac', ''),
      line('Tin Harbor/Low Tide/04 lost.flac', 'Tin Harbor/[2024] Low Tide/04. Lost.flac'),
      line('Tin Harbor/Low Tide/02 shoals.flac', '', 'deleted'),
      '',
    ].join('\n'));
    const running = await start('/api/', { scan: false, roots: [{ name: 'Old', dir: old }, { name: 'New', dir: fresh }] });
    const token = await pair(running);
    const of = (file: string) => Buffer.from(file, 'utf8').toString('base64url');
    const ids = ['01 still here', '02 shoals', '03 bonus', '04 lost', '05 unknown'].map((name) => of(`Old/Tin Harbor/Low Tide/${name}.flac`));

    const reply = await running.call('POST', 'moved', { token, body: { ids: [...ids, 'not an id', ids[1]] } });
    expect(reply.status).toBe(200);
    expect(reply.json()).toEqual({
      moved: {
        // The later line for a song wins, and the note of its deletion doesn't undo it.
        [ids[1]]: of('New/Tin Harbor/[2024] Low Tide/02. Shoals.flac'),
        // The fresh album has no such song.
        [ids[2]]: null,
      },
    });
    // The record itself can't be browsed to or asked for.
    expect((await running.call('GET', 'browse?path=New', { token })).json<BrowseResponse>().folders.map((folder) => folder.name)).toEqual(['Tin Harbor']);

    expect((await running.call('POST', 'moved', { body: { ids } })).status).toBe(401);
    expect((await running.call('POST', 'moved', { token, body: { ids: 'all' } })).status).toBe(400);
    expect((await running.call('GET', 'moved', { token })).status).toBe(405);
  });
});

describe('what a user marks and hears', () => {
  const of = (file: string) => Buffer.from(file, 'utf8').toString('base64url');
  const song = (file: string, album = 'Night Market') => ({ id: of(file), title: file.split('/').pop()!, artist: 'Midori Vale', album, trackNumber: null, discNumber: null, durationSeconds: 10 });

  it('keeps favourite songs and albums for each user alone', async () => {
    const home = await start('/api/');
    const aki = home.pairing.addUser('Aki')!;
    const owner = await pair(home, 'Owner phone');
    const friend = (await home.call('POST', 'pair', { body: { code: home.pairing.createCode(1, aki.id).code, deviceName: 'Aki phone' } })).json<PairResponse>().token;
    const a = song('main/Night Market/a.flac');
    const b = song('main/Night Market/b.flac');

    expect((await home.call('GET', 'favourites', { token: owner })).json()).toEqual({ songs: [], albums: [] });
    expect((await home.call('PUT', `favourites/songs/${a.id}`, { token: owner, body: { track: a } })).status).toBe(204);
    expect((await home.call('PUT', `favourites/songs/${b.id}`, { token: owner, body: { track: b } })).status).toBe(204);
    // Marked again, it stays where it was, with what is known about it now.
    expect((await home.call('PUT', `favourites/songs/${a.id}`, { token: owner, body: { track: { ...a, title: 'Renamed' } } })).status).toBe(204);
    expect((await home.call('PUT', `favourites/albums/${of('main/Night Market')}`, { token: owner, body: { title: 'Night Market', artist: 'Midori Vale' } })).status).toBe(204);
    const at = new Date(clock).toISOString();
    expect((await home.call('GET', 'favourites', { token: owner })).json()).toEqual({
      songs: [{ track: { ...a, title: 'Renamed' }, addedAt: at }, { track: b, addedAt: at }],
      albums: [{ path: 'main/Night Market', title: 'Night Market', artist: 'Midori Vale', addedAt: at }],
    });
    expect((await home.call('GET', 'favourites', { token: friend })).json()).toEqual({ songs: [], albums: [] });

    expect((await home.call('DELETE', `favourites/songs/${a.id}`, { token: owner })).status).toBe(204);
    expect((await home.call('DELETE', `favourites/albums/${of('main/Night Market')}`, { token: owner })).status).toBe(204);
    expect((await home.call('GET', 'favourites', { token: owner })).json()).toEqual({ songs: [{ track: b, addedAt: at }], albums: [] });

    // The id in the address is the song's; anything else is refused.
    expect((await home.call('PUT', `favourites/songs/${a.id}`, { token: owner, body: { track: b } })).status).toBe(400);
    expect((await home.call('PUT', 'favourites/songs/not*an*id', { token: owner, body: { track: a } })).status).toBe(400);
    expect((await home.call('GET', 'favourites')).status).toBe(401);
  });

  it('counts plays and says what was heard lately, to the listener alone', async () => {
    const home = await start('/api/');
    const aki = home.pairing.addUser('Aki')!;
    const owner = await pair(home, 'Owner phone');
    const friend = (await home.call('POST', 'pair', { body: { code: home.pairing.createCode(1, aki.id).code, deviceName: 'Aki phone' } })).json<PairResponse>().token;
    const a = song('main/Night Market/a.flac');
    const b = song('main/Night Market/b.flac');
    const c = song('main/Low Tide/c.flac', 'Low Tide');
    const started = clock;
    for (const track of [a, b, a, c, a]) {
      clock += 60_000;
      expect((await home.call('POST', 'plays', { token: owner, body: { track } })).status).toBe(204);
    }
    // A play the device couldn't report at the time keeps its own time; one from the future is given now.
    const earlier = new Date(started - 3_600_000).toISOString();
    expect((await home.call('POST', 'plays', { token: owner, body: { track: b, at: earlier } })).status).toBe(204);
    expect((await home.call('POST', 'plays', { token: friend, body: { track: c, at: new Date(clock + 9e9).toISOString() } })).status).toBe(204);

    const history = (await home.call('GET', 'history', { token: owner })).json<{ total: number; plays: { at: string; track: { id: string } }[]; top: { track: { id: string }; count: number }[]; albums: { path: string; title: string }[] }>();
    expect(history.total).toBe(6);
    expect(history.plays.map((play) => play.track.id)).toEqual([a.id, c.id, a.id, b.id, a.id, b.id]);
    expect(history.plays[5].at).toBe(earlier);
    expect(history.top.map((entry) => [entry.track.id, entry.count])).toEqual([[a.id, 3], [b.id, 2], [c.id, 1]]);
    expect(history.albums.map((album) => [album.path, album.title])).toEqual([['main/Night Market', 'Night Market'], ['main/Low Tide', 'Low Tide']]);
    expect((await home.call('POST', 'plays/counts', { token: owner, body: { ids: [a.id, c.id, 'unknown'] } })).json()).toEqual({ counts: { [a.id]: 3, [c.id]: 1 } });

    const theirs = (await home.call('GET', 'history', { token: friend })).json<{ total: number; plays: { at: string }[] }>();
    expect(theirs.total).toBe(1);
    expect(theirs.plays[0].at).toBe(new Date(clock).toISOString());
    expect((await home.call('POST', 'plays', { token: owner, body: { track: { title: 'no id' } } })).status).toBe(400);

    // A user who is removed takes what they marked and heard with them.
    new ListeningStore(path.join(dir, `data${servers.length - 1}`)).removeUser(aki.id);
    home.pairing.removeUser(aki.id);
    const again = home.pairing.addUser('Aki')!;
    expect(again.id).not.toBe(aki.id);
  });
});

describe('remote control between a user\'s devices', () => {
  /** Opens a device's stream and collects what the server sends down it. */
  function listen(running: Running, token: string): { events: Record<string, unknown>[]; together: Record<string, unknown>[]; close: () => void; next: (count: number) => Promise<void> } {
    // What is said about devices and commands, and apart from it what is said about listening together.
    const events: Record<string, unknown>[] = [];
    const together: Record<string, unknown>[] = [];
    const req = request(`${running.base}events`, { headers: { authorization: `Bearer ${token}` } }, (res) => {
      let pending = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        pending += chunk;
        for (let cut = pending.indexOf('\n\n'); cut >= 0; cut = pending.indexOf('\n\n')) {
          const block = pending.slice(0, cut);
          pending = pending.slice(cut + 2);
          if (!block.startsWith('data: ')) continue;
          const event = JSON.parse(block.slice(6)) as Record<string, unknown>;
          (event.type === 'rooms' || event.type === 'room' ? together : events).push(event);
        }
      });
    });
    req.on('error', () => {});
    req.end();
    const next = async (count: number): Promise<void> => {
      for (let tries = 0; events.length < count && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(events.length).toBeGreaterThanOrEqual(count);
    };
    return { events, together, close: () => req.destroy(), next };
  }

  it('tells a user\'s devices about each other, carries commands between them, and keeps other users out', async () => {
    const home = await start('/api/');
    const aki = home.pairing.addUser('Aki')!;
    const phone = await pair(home, 'Phone');
    const laptop = await pair(home, 'Laptop');
    const stranger = (await home.call('POST', 'pair', { body: { code: home.pairing.createCode(1, aki.id).code, deviceName: 'Aki phone' } })).json<PairResponse>().token;
    expect((await home.call('GET', 'events')).status).toBe(401);

    // The phone connects and is told it is alone; then the laptop, and both are told of both.
    const onPhone = listen(home, phone);
    await onPhone.next(1);
    const first = onPhone.events[0] as { type: string; you: string; devices: { id: string; name: string; state: unknown }[] };
    expect(first.type).toBe('devices');
    expect(first.devices).toEqual([{ id: first.you, name: 'Phone', state: null }]);
    const onLaptop = listen(home, laptop);
    await onLaptop.next(1);
    await onPhone.next(2);
    const laptopId = (onLaptop.events[0] as { you: string }).you;
    expect((onPhone.events[1] as { devices: { name: string }[] }).devices.map((device) => device.name).sort()).toEqual(['Laptop', 'Phone']);
    // Another user's device sees only itself.
    const onStranger = listen(home, stranger);
    await onStranger.next(1);
    expect((onStranger.events[0] as { devices: { name: string }[] }).devices.map((device) => device.name)).toEqual(['Aki phone']);

    // The laptop says what it is playing; the phone hears. A later word about the position alone keeps the rest.
    const song = { id: 'bWFpbi9hLmZsYWM', title: 'Paper Lanterns', artist: 'Midori Vale', album: '', trackNumber: null, discNumber: null, durationSeconds: 50 };
    expect((await home.call('POST', 'state', { token: laptop, body: { playing: true, position: 3, at: 1000, duration: 50, track: song, queue: [song], order: [0], extra: 'dropped' } })).status).toBe(204);
    expect((await home.call('POST', 'state', { token: laptop, body: { position: 9, at: 7000 } })).status).toBe(204);
    await onPhone.next(4);
    const heard = (onPhone.events[3] as { devices: { id: string; state: unknown }[] }).devices.find((device) => device.id === laptopId);
    expect(heard?.state).toEqual({ playing: true, position: 9, at: 7000, duration: 50, track: song, queue: [song], order: [0] });
    expect(onStranger.events).toHaveLength(1);

    // The phone pauses the laptop, and moves it; the laptop is told who asked.
    expect((await home.call('POST', `devices/${laptopId}/command`, { token: phone, body: { action: 'pause' } })).status).toBe(204);
    expect((await home.call('POST', `devices/${laptopId}/command`, { token: phone, body: { action: 'seek', value: 30 } })).status).toBe(204);
    for (let tries = 0; onLaptop.events.filter((event) => event.type === 'command').length < 2 && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    const commands = onLaptop.events.filter((event) => event.type === 'command');
    expect(commands).toEqual([
      { type: 'command', from: first.you, command: { action: 'pause' } },
      { type: 'command', from: first.you, command: { action: 'seek', value: 30 } },
    ]);
    // Not another user's device, not a device that isn't there, not a command that isn't one.
    expect((await home.call('POST', `devices/${laptopId}/command`, { token: stranger, body: { action: 'pause' } })).status).toBe(404);
    expect((await home.call('POST', 'devices/nobody/command', { token: phone, body: { action: 'pause' } })).status).toBe(404);
    expect((await home.call('POST', `devices/${laptopId}/command`, { token: phone, body: { action: 'explode' } })).status).toBe(400);
    expect((await home.call('POST', `devices/${laptopId}/command`, { token: phone, body: { action: 'seek' } })).status).toBe(400);

    // The laptop closes the player: the phone is told it is alone again.
    const before = onPhone.events.length;
    onLaptop.close();
    await onPhone.next(before + 1);
    expect((onPhone.events[onPhone.events.length - 1] as { devices: { name: string }[] }).devices.map((device) => device.name)).toEqual(['Phone']);
    onPhone.close();
    onStranger.close();
  });

  it('lets a device share what it plays with everyone, and tells those who listen along where the song is', async () => {
    const home = await start('/api/');
    const aki = home.pairing.addUser('Aki')!;
    const host = await pair(home, 'Living room');
    const guest = (await home.call('POST', 'pair', { body: { code: home.pairing.createCode(1, aki.id).code, deviceName: 'Aki phone' } })).json<PairResponse>().token;
    const onHost = listen(home, host);
    const onGuest = listen(home, guest);
    await onHost.next(1);
    await onGuest.next(1);
    const hostId = (onHost.events[0] as { you: string }).you;
    const settle = async (list: Record<string, unknown>[], count: number) => { for (let tries = 0; list.length < count && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 10)); };
    // Nobody is sharing; a device that isn't sharing can't be listened along with.
    await settle(onGuest.together, 1);
    expect(onGuest.together[0]).toEqual({ type: 'rooms', rooms: [], joined: null });
    expect((await home.call('POST', `rooms/${hostId}/join`, { token: guest })).status).toBe(404);

    // The host plays a song and shares; everyone, the other user included, is told who and what.
    const song = { id: 'bWFpbi9hLmZsYWM', title: 'Paper Lanterns', artist: 'Midori Vale', album: '', trackNumber: null, discNumber: null, durationSeconds: 50 };
    await home.call('POST', 'state', { token: host, body: { playing: true, position: 12, at: 5, duration: 50, track: song, queue: [song], order: [0] } });
    expect((await home.call('POST', 'room', { token: host })).status).toBe(204);
    await settle(onGuest.together, 2);
    expect(onGuest.together[1]).toEqual({ type: 'rooms', rooms: [{ id: hostId, by: 'Owner', device: 'Living room', track: song, listeners: 0 }], joined: null });

    // The guest listens along: it is told the song and its place at once, by the server's clock, without the queue.
    clock += 4000;
    expect((await home.call('POST', `rooms/${hostId}/join`, { token: guest })).status).toBe(204);
    await settle(onGuest.together, 4);
    const joined = onGuest.together.find((event) => event.type === 'rooms' && event.joined === hostId) as { rooms: { listeners: number }[] };
    expect(joined.rooms[0].listeners).toBe(1);
    const told = onGuest.together.find((event) => event.type === 'room') as { room: { id: string; state: Record<string, unknown>; heardAt: number; now: number } };
    expect(told.room.id).toBe(hostId);
    expect(told.room.state).toEqual({ playing: true, position: 12, at: 5, duration: 50, track: song });
    expect(told.room.now - told.room.heardAt).toBe(4000);
    // The host is not told its own state back.
    expect(onHost.together.some((event) => event.type === 'room')).toBe(false);

    // Every word from the host reaches the listener; when the host stops sharing, the listener is let go.
    await home.call('POST', 'state', { token: host, body: { playing: false, position: 20, at: 9 } });
    await settle(onGuest.together, 5);
    expect((onGuest.together[onGuest.together.length - 1] as { room: { state: { playing: boolean; position: number } } }).room.state).toMatchObject({ playing: false, position: 20 });
    expect((await home.call('DELETE', 'room', { token: host })).status).toBe(204);
    await settle(onGuest.together, 6);
    expect(onGuest.together[onGuest.together.length - 1]).toEqual({ type: 'rooms', rooms: [], joined: null });
    onHost.close();
    onGuest.close();
  });

  it('goes on serving when devices drop their streams at awkward moments', async () => {
    const home = await start('/api/');
    const tokens = [await pair(home, 'One'), await pair(home, 'Two'), await pair(home, 'Three')];
    const song = { id: 'bWFpbi9hLmZsYWM', title: 'Paper Lanterns', artist: '', album: '', trackNumber: null, discNumber: null, durationSeconds: 50 };
    for (let round = 0; round < 15; round++) {
      const streams = tokens.map((token) => listen(home, token));
      await streams[0].next(1);
      // Streams are cut while the others are being written to about them and about what is playing.
      const telling = tokens.map((token, index) => home.call('POST', 'state', { token, body: { playing: true, position: round + index, at: 1, duration: 50, track: song } }));
      streams[1].close();
      streams[2].close();
      await Promise.all(telling);
      streams[0].close();
    }
    expect((await home.call('GET', 'health')).status).toBe(200);
  });
});
