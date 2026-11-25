import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowseResponse, LibraryResponse, NasTrack, PairResponse, TicketResponse } from '../../src/shared/api';
import { createApp } from './app';
import { PairingStore, TICKET_LIFETIME_SECONDS, loadOrCreateSecret, signTicket } from './auth';
import type { LibraryRoot } from './config';
import { Library } from './library';
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
  const library = new Library(roots);
  if (options.scan ?? true) await library.scan();
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
    pairing,
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
    expect(rest).toEqual({ serverName: 'Test NAS', deviceName: 'Kitchen tablet' });
    expect((await app.call('POST', 'pair', { body: { code, deviceName: 'Again' } })).status).toBe(403);

    // me
    const me = await app.call('GET', 'me', { token });
    expect(me.status).toBe(200);
    expect(me.json()).toEqual({ serverName: 'Test NAS', deviceName: 'Kitchen tablet' });

    // library
    const library = await app.call('GET', 'library', { token });
    expect(library.status).toBe(200);
    const list = library.json<LibraryResponse>();
    expect(list.serverName).toBe('Test NAS');
    expect(typeof list.scannedAt).toBe('string');
    expect(list.tracks.map((track) => track.title)).toEqual(['Loose Song', 'Paper Lanterns']);
    const track = list.tracks[1];
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
    track = (await app.call('GET', 'library', { token })).json<LibraryResponse>().tracks[1];
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
    const other = (await app.call('GET', 'library', { token })).json<LibraryResponse>().tracks[0];

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
    expect(reply.headers['access-control-allow-methods']).toBe('GET, HEAD, POST, DELETE, OPTIONS');
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
    const { tracks } = (await other.call('GET', 'library', { token })).json<LibraryResponse>();
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
  const song = fakeFlac(['TITLE=A Tag Nobody Reads', 'ARTIST=Tin Harbor'], 4000);
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
    expect(reply.json()).toEqual({ serverName: 'Test NAS', scannedAt: null, tracks: [] });
  });

  it('lists the roots, in the order configured, for an empty or missing path', async () => {
    const roots = { serverName: 'Test NAS', path: '', parent: null, folders: [{ name: 'Shelf', path: 'Shelf' }, { name: 'main', path: 'main' }], tracks: [] };
    for (const reply of [await browse(), await browse('')]) {
      expect(reply.status).toBe(200);
      expect(reply.json()).toEqual(roots);
    }
  });

  it('lists a root and a nested folder, with their parents', async () => {
    expect((await browse('Shelf')).json()).toEqual({
      serverName: 'Test NAS', path: 'Shelf', parent: '', folders: [{ name: 'Tin Harbor', path: 'Shelf/Tin Harbor' }], tracks: [],
    });
    const artist = (await browse('Shelf/Tin Harbor')).json<BrowseResponse>();
    expect(artist).toMatchObject({ path: 'Shelf/Tin Harbor', parent: 'Shelf', folders: [{ name: 'Low Tide', path: 'Shelf/Tin Harbor/Low Tide' }] });

    const album = (await browse('Shelf/Tin Harbor/Low Tide')).json<BrowseResponse>();
    expect(album.path).toBe('Shelf/Tin Harbor/Low Tide');
    expect(album.parent).toBe('Shelf/Tin Harbor');
    // Numbers in order, and nothing the server never lists.
    expect(album.folders).toEqual([
      { name: 'disc 1', path: 'Shelf/Tin Harbor/Low Tide/disc 1' },
      { name: 'Disc 2', path: 'Shelf/Tin Harbor/Low Tide/Disc 2' },
      { name: 'Disc 10', path: 'Shelf/Tin Harbor/Low Tide/Disc 10' },
    ]);
    expect(album.tracks).toEqual([
      { id: id('Shelf/Tin Harbor/Low Tide/1 - c.MP3'), title: '1 - c', artist: '', album: '', trackNumber: null, discNumber: null, durationSeconds: null, lyrics: [] },
      { id: id('Shelf/Tin Harbor/Low Tide/2 - b.flac'), title: '2 - b', artist: '', album: '', trackNumber: null, discNumber: null, durationSeconds: null, lyrics: [] },
      {
        id: id('Shelf/Tin Harbor/Low Tide/10 - a.flac'), title: '10 - a', artist: '', album: '', trackNumber: null, discNumber: null, durationSeconds: null,
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
