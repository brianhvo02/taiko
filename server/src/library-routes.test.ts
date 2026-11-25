/** The library over HTTP: `GET library`, `GET library/search`, `POST library/scan`, with one root of two scanned. */
import { statSync, utimesSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowseResponse, LibraryResponse, SearchResponse, TicketResponse } from '../../src/shared/api';
import { MAX_SEARCH_CHARS, SCAN_REQUEST_GAP_MS, createApp } from './app';
import { PlaylistStore } from './playlists';
import type { AppDeps } from './app';
import { PairingStore, loadOrCreateSecret } from './auth';
import { Library } from './library';
import { TagCache } from './tag-cache';
import { fakeFlac, removeDir, tempDir, writeFile } from './test-helpers';

interface Reply {
  status: number;
  type: string | undefined;
  body: Buffer;
  json: <T = Record<string, unknown>>() => T;
}

let dir: string;
let music: string;
let clock = Date.parse('2026-03-01T12:00:00Z');
const servers: Server[] = [];
const id = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

interface Running {
  base: string;
  token: string;
  pairing: PairingStore;
  call: (method: string, route: string, token?: string) => Promise<Reply>;
}

/** A server on its own port over the two roots, with whatever library it is given. */
async function start(library: AppDeps['library'], tags?: TagCache): Promise<Running> {
  const roots = [{ name: 'Music', dir: music }, { name: 'Downloads', dir: path.join(dir, 'downloads') }];
  const data = path.join(dir, `data${servers.length}`);
  const pairing = new PairingStore(data, () => clock);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
  server.on('request', createApp({
    config: { publicBase: base, basePath: '/api/', serverName: 'Test NAS', appOrigins: [], roots },
    library, tags, pairing, playlists: new PlaylistStore(data), secret: loadOrCreateSecret(data), now: () => clock,
  }));
  const call: Running['call'] = (method, route, token) => new Promise((resolve, reject) => {
    const req = request(route.startsWith('http') ? route : base + route, { method, headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body, json: () => JSON.parse(body.toString('utf8')) });
      });
    });
    req.on('error', reject);
    req.end();
  });
  return { base, pairing, call, token: pairing.redeem(pairing.createCode().code, 'Phone')!.token };
}

let library: Library;
let tags: TagCache;
let app: Running;
const market = (): string => path.join(music, 'Midori Vale', '[2021] Night Market');

beforeAll(async () => {
  dir = tempDir();
  music = path.join(dir, 'music');
  const common = ['ARTIST=Midori Vale', 'ALBUMARTIST=Midori Vale', 'ALBUM=Night Market', 'ALBUMSORT=Yoichi', 'DATE=2021-03-04'];
  writeFile(path.join(market(), '01. Paper Lanterns.flac'), fakeFlac(['TITLE=Paper Lanterns', 'TITLESORT=Kami no Tourou', 'TRACKNUMBER=1', ...common], 2000));
  writeFile(path.join(market(), '02. Closing Bell.flac'), fakeFlac(['TITLE=Closing Bell', 'TITLE_EN=Last Orders', 'TRACKNUMBER=2', ...common]));
  writeFile(path.join(market(), '01. Paper Lanterns.lrc'), '[00:01.00]lanterns');
  writeFile(path.join(market(), 'cover.jpg'), 'the picture of the night market');
  // A compilation: no album artist, and the songs' artists differ. It has no cover.
  writeFile(path.join(music, 'Various', 'Harbor Lights', '01. Gulls.flac'), fakeFlac(['TITLE=Gulls', 'ARTIST=Tin Harbor', 'ALBUM=Harbor Lights', 'DATE=2019']));
  writeFile(path.join(music, 'Various', 'Harbor Lights', '02. Wake.flac'), fakeFlac(['TITLE=Wake', 'ARTIST=Anchor Line', 'ALBUM=Harbor Lights', 'DATE=2019']));
  // In the root that isn't scanned.
  writeFile(path.join(dir, 'downloads', 'Rips', 'Unsorted Lanterns.flac'), fakeFlac(['TITLE=Unsorted Lanterns', 'ARTIST=Midori Vale', 'ALBUM=Rips'], 3000));

  // Whole-second times, so a test can put a file's time back exactly after changing it.
  const when = new Date('2026-02-03T04:05:06Z');
  for (const name of ['01. Paper Lanterns.flac', '02. Closing Bell.flac']) utimesSync(path.join(market(), name), when, when);

  tags = new TagCache();
  library = new Library([{ name: 'Music', dir: music }], tags);
  library.scan();
  await library.idle();
  app = await start(library, tags);
});

afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  removeDir(dir);
});

describe('GET library', () => {
  it('lists the albums of the scanned root, with covers signed like the browser\'s', async () => {
    const reply = await app.call('GET', 'library', app.token);
    expect(reply.status).toBe(200);
    const list = reply.json<LibraryResponse>();
    expect(list).toMatchObject({ serverName: 'Test NAS', enabled: true, scanning: false });
    expect(Date.parse(list.scannedAt!)).not.toBeNaN();
    const [album, compilation] = list.albums;
    expect(list.albums).toHaveLength(2);
    expect(album).toEqual({
      path: 'Music/Midori Vale/[2021] Night Market', title: 'Night Market', titleRoman: 'Yoichi', artist: 'Midori Vale', date: '2021-03-04',
      trackCount: 2, durationSeconds: 20, cover: album.cover,
      addedAt: statSync(market()).birthtimeMs || Math.max(statSync(path.join(market(), '01. Paper Lanterns.flac')).mtimeMs, statSync(path.join(market(), '02. Closing Bell.flac')).mtimeMs),
    });
    expect(compilation).toMatchObject({ path: 'Music/Various/Harbor Lights', title: 'Harbor Lights', artist: '', date: '2019', trackCount: 2, cover: null });
    expect(compilation).not.toHaveProperty('hasCover');
    expect(JSON.stringify(list)).not.toContain('Rips');

    // The cover's address is the one `browse` gives for the folder, and it loads without the token.
    const folder = (await app.call('GET', `browse?path=${encodeURIComponent(album.path)}`, app.token)).json<BrowseResponse>();
    expect(album.cover).toBe(`${folder.cover}&size=small`);
    expect(album.cover).toMatch(/\/api\/cover\?path=Music%2FMidori%20Vale%2F%5B2021%5D%20Night%20Market&exp=\d+&sig=[0-9a-f]{64}&size=small$/);
    const picture = await app.call('GET', album.cover!);
    expect(picture.status).toBe(200);
    expect(picture.type).toBe('image/jpeg');
    expect(picture.body.toString()).toBe('the picture of the night market');
    // The album's songs are what `browse` lists there.
    expect(folder.tracks.map((track) => track.title)).toEqual(['Paper Lanterns', 'Closing Bell']);
  });

  it('makes the cover address for the day it is asked on, not the day of the scan', async () => {
    const today = (await app.call('GET', 'library', app.token)).json<LibraryResponse>().albums[0].cover!;
    expect((await app.call('GET', 'library', app.token)).json<LibraryResponse>().albums[0].cover).toBe(today);
    clock += 3 * 86_400_000;
    try {
      expect((await app.call('GET', today)).status).toBe(403);
      const later = (await app.call('GET', 'library', app.token)).json<LibraryResponse>().albums[0].cover!;
      expect(later).not.toBe(today);
      expect((await app.call('GET', later)).status).toBe(200);
    } finally {
      clock -= 3 * 86_400_000;
    }
  });

  it('says so while a scan is running', async () => {
    const busy = await start({ enabled: true, scanning: true, scannedAt: null, albums: [], search: () => [], scan: () => false });
    expect((await busy.call('GET', 'library', busy.token)).json()).toEqual({ serverName: 'Test NAS', enabled: true, scanning: true, scannedAt: null, albums: [] });
    expect((await busy.call('POST', 'library/scan', busy.token)).json()).toEqual({ started: false });
  });

  it('is off and empty when no root is scanned', async () => {
    const offLibrary = new Library([], new TagCache());
    const off = await start(offLibrary);
    expect((await off.call('GET', 'library', off.token)).json()).toEqual({ serverName: 'Test NAS', enabled: false, scanning: false, scannedAt: null, albums: [] });
    expect((await off.call('GET', 'library/search?q=lanterns', off.token)).json()).toEqual({ tracks: [] });
    expect((await off.call('POST', 'library/scan', off.token)).json()).toEqual({ started: false });
    // The folders are all still there.
    expect((await off.call('GET', 'browse?path=Music', off.token)).status).toBe(200);
  });

  it('needs a token, and its routes are not mistaken for one another', async () => {
    for (const [method, route] of [['GET', 'library'], ['GET', 'library/search?q=x'], ['POST', 'library/scan']]) {
      expect((await app.call(method, route)).status).toBe(401);
      expect((await app.call(method, route, 'x'.repeat(43))).status).toBe(401);
    }
    for (const route of ['library/', 'library/nope', 'library/search/x', 'library/scan/now', 'library/search/', 'librarysearch', 'tracks/library/scan', 'library/scan/ticket']) {
      const reply = await app.call('GET', route, app.token);
      expect(reply.status).toBe(404);
      expect(reply.json()).toEqual({ error: 'not-found' });
      expect((await app.call('POST', route, app.token)).status).toBe(404);
    }
    expect((await app.call('POST', 'library', app.token)).status).toBe(405);
    expect((await app.call('POST', 'library/search?q=x', app.token)).status).toBe(405);
    expect((await app.call('GET', 'library/scan', app.token)).status).toBe(405);
    // A GET of the scan route starts nothing.
    expect(library.scanning).toBe(false);
  });
});

describe('the roots outside the library', () => {
  it('still browse and play', async () => {
    expect((await app.call('GET', 'browse', app.token)).json<BrowseResponse>().folders.map((folder) => folder.name)).toEqual(['Music', 'Downloads']);
    const folder = (await app.call('GET', 'browse?path=Downloads/Rips', app.token)).json<BrowseResponse>();
    expect(folder.tracks).toHaveLength(1);
    expect(folder.tracks[0]).toMatchObject({ id: id('Downloads/Rips/Unsorted Lanterns.flac'), title: 'Unsorted Lanterns', artist: 'Midori Vale', album: 'Rips' });
    const ticket = (await app.call('POST', `tracks/${folder.tracks[0].id}/ticket`, app.token)).json<TicketResponse>();
    const audio = await app.call('GET', ticket.url);
    expect(audio.status).toBe(200);
    expect(audio.body.equals(fakeFlac(['TITLE=Unsorted Lanterns', 'ARTIST=Midori Vale', 'ALBUM=Rips'], 3000))).toBe(true);
    // But its songs are not in the search.
    expect((await app.call('GET', 'library/search?q=unsorted', app.token)).json()).toEqual({ tracks: [] });
  });
});

describe('the shared tag cache', () => {
  it('means browsing a scanned album reads no file again', async () => {
    const file = path.join(market(), '02. Closing Bell.flac');
    const before = statSync(file);
    const original = fakeFlac(['TITLE=Closing Bell', 'TITLE_EN=Last Orders', 'TRACKNUMBER=2', 'ARTIST=Midori Vale', 'ALBUMARTIST=Midori Vale', 'ALBUM=Night Market', 'ALBUMSORT=Yoichi', 'DATE=2021-03-04']);
    // Different tags in a file of the same size and time: only a second read of the file would show them.
    const changed = fakeFlac(['TITLE=Opening Bell', 'TITLE_EN=Last Orders', 'TRACKNUMBER=2', 'ARTIST=Midori Vale', 'ALBUMARTIST=Midori Vale', 'ALBUM=Night Market', 'ALBUMSORT=Yoichi', 'DATE=2021-03-04']);
    expect(changed).toHaveLength(original.length);
    writeFile(file, changed);
    utimesSync(file, before.atime, before.mtime);
    try {
      const route = `browse?path=${encodeURIComponent('Music/Midori Vale/[2021] Night Market')}`;
      const shared = (await app.call('GET', route, app.token)).json<BrowseResponse>();
      expect(shared.tracks.map((track) => track.title)).toEqual(['Paper Lanterns', 'Closing Bell']);
      // A server whose browser has a cache of its own has to read the file, and sees the change.
      const apart = await start(library);
      expect((await apart.call('GET', route, apart.token)).json<BrowseResponse>().tracks.map((track) => track.title)).toEqual(['Paper Lanterns', 'Opening Bell']);
    } finally {
      writeFile(file, original);
      utimesSync(file, before.atime, before.mtime);
    }
  });
});

describe('GET library/search', () => {
  const search = async (query: string): Promise<SearchResponse> => {
    const reply = await app.call('GET', `library/search?q=${encodeURIComponent(query)}`, app.token);
    expect(reply.status).toBe(200);
    return reply.json<SearchResponse>();
  };

  it('finds songs by every word, as the browser lists them', async () => {
    const found = await search('bell vale');
    expect(found.tracks).toEqual([{
      id: id('Music/Midori Vale/[2021] Night Market/02. Closing Bell.flac'), title: 'Closing Bell', artist: 'Midori Vale', album: 'Night Market',
      trackNumber: 2, discNumber: null, durationSeconds: 10, sampleRate: 44100, bitsPerSample: 16, albumRoman: 'Yoichi', titleEnglish: 'Last Orders', albumArtist: 'Midori Vale', date: '2021-03-04', lyrics: [],
    }]);
    const folder = (await app.call('GET', `browse?path=${encodeURIComponent('Music/Midori Vale/[2021] Night Market')}`, app.token)).json<BrowseResponse>();
    expect(found.tracks[0]).toEqual(folder.tracks[1]);
    expect((await search('tourou')).tracks.map((track) => track.title)).toEqual(['Paper Lanterns']);
    expect((await search('last orders')).tracks.map((track) => track.title)).toEqual(['Closing Bell']);
    expect((await search('ＹＯＩＣＨＩ　ｐａｐｅｒ')).tracks.map((track) => track.title)).toEqual(['Paper Lanterns']);
    expect((await search('harbor')).tracks.map((track) => track.title)).toEqual(['Gulls', 'Wake']);
    expect((await search('gulls wake')).tracks).toEqual([]);
  });

  it('gives nothing for an empty question', async () => {
    expect(await search('')).toEqual({ tracks: [] });
    expect(await search('   ')).toEqual({ tracks: [] });
    expect((await app.call('GET', 'library/search', app.token)).json()).toEqual({ tracks: [] });
  });

  it('answers 400 for a question over 200 characters', async () => {
    expect(MAX_SEARCH_CHARS).toBe(200);
    expect((await app.call('GET', `library/search?q=${'a'.repeat(200)}`, app.token)).status).toBe(200);
    const reply = await app.call('GET', `library/search?q=${'a'.repeat(201)}`, app.token);
    expect(reply.status).toBe(400);
    expect(reply.json()).toEqual({ error: 'bad-request' });
  });
});

describe('POST library/scan', () => {
  it('starts a scan, at most once in ten seconds per device, and the new album appears', async () => {
    const before = (await app.call('GET', 'library', app.token)).json<LibraryResponse>();
    writeFile(path.join(music, 'Anchor Line', '[2024] Signal Fires', '01. Flare.flac'), fakeFlac(['TITLE=Flare', 'ARTIST=Anchor Line', 'ALBUM=Signal Fires', 'DATE=2024']));
    // Nothing is noticed until a scan.
    expect((await app.call('GET', 'library', app.token)).json<LibraryResponse>().albums).toHaveLength(before.albums.length);

    const first = await app.call('POST', 'library/scan', app.token);
    expect(first.status).toBe(200);
    expect(first.json()).toEqual({ started: true });
    await library.idle();
    const after = (await app.call('GET', 'library', app.token)).json<LibraryResponse>();
    expect(after.scanning).toBe(false);
    expect(after.albums.map((album) => album.title)).toEqual(['Signal Fires', 'Night Market', 'Harbor Lights']);
    expect(Date.parse(after.scannedAt!)).toBeGreaterThanOrEqual(Date.parse(before.scannedAt!));
    expect((await app.call('GET', 'library/search?q=flare', app.token)).json<SearchResponse>().tracks.map((track) => track.title)).toEqual(['Flare']);

    // Asked again within ten seconds: nothing starts, and it is not an error.
    clock += SCAN_REQUEST_GAP_MS - 1;
    const again = await app.call('POST', 'library/scan', app.token);
    expect(again.status).toBe(200);
    expect(again.json()).toEqual({ started: false });
    expect(library.scanning).toBe(false);
    // Another device has its own ten seconds.
    const second = app.pairing.redeem(app.pairing.createCode().code, 'Laptop')!.token;
    expect((await app.call('POST', 'library/scan', second)).json()).toEqual({ started: true });
    await library.idle();
    // And the first may ask again once they have passed.
    clock += 1;
    expect((await app.call('POST', 'library/scan', app.token)).json()).toEqual({ started: true });
    await library.idle();
  });

  it('needs a token', async () => {
    const reply = await app.call('POST', 'library/scan');
    expect(reply.status).toBe(401);
    expect(reply.json()).toEqual({ error: 'unauthorized' });
  });
});
