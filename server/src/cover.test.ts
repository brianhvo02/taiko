/** Album covers and the other forms of a song's names, through the folder browser. */
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowseResponse } from '../../src/shared/api';
import { createApp } from './app';
import { PlaylistStore } from './playlists';
import { PairingStore, loadOrCreateSecret } from './auth';
import { findCover } from './cover';
import { Library } from './library';
import { TagCache } from './tag-cache';
import { fakeFlac, removeDir, tempDir, writeFile } from './test-helpers';

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

let dir: string;
let server: Server;
let base: string;
let token: string;
let clock = Date.UTC(2026, 10, 25, 3, 0, 0);

function call(method: string, route: string, auth = false): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(route.startsWith('http') ? route : base + route, { method, headers: auth ? { authorization: `Bearer ${token}` } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function browse(folder: string): Promise<BrowseResponse> {
  const reply = await call('GET', `browse?path=${encodeURIComponent(folder)}`, true);
  expect(reply.status).toBe(200);
  return JSON.parse(reply.body.toString('utf8')) as BrowseResponse;
}

beforeAll(async () => {
  dir = tempDir();
  const music = path.join(dir, 'music');
  // An album as a tagger for Japanese music writes it: a cover picture, and names with a reading and an English form.
  const album = path.join(music, 'Midori Vale', 'Night Market');
  writeFile(path.join(album, '01. 紙の灯籠.flac'), fakeFlac([
    'TITLE=紙の灯籠', 'ARTIST=緑の谷', 'ALBUM=夜市', 'TRACKNUMBER=1',
    'TITLESORT=Kami no Tourou', 'ARTISTSORT=Midori no Tani', 'ALBUMSORT=Yoichi',
    'TITLE_EN=Paper Lanterns', 'ARTIST_EN=Midori Vale', 'ALBUM_EN=Night Market', 'APPLE_SONG_ID=9900112233',
  ]));
  writeFile(path.join(album, '02. plain.flac'), fakeFlac(['TITLE=Plain Song', 'ARTIST=Midori Vale']));
  writeFile(path.join(album, 'cover.jpg'), JPEG);
  writeFile(path.join(album, 'Folder.png'), PNG);
  // A folder with only a "front" picture, one with none, and one whose only picture is empty.
  writeFile(path.join(music, 'Fronted', 'Front.PNG'), PNG);
  writeFile(path.join(music, 'Fronted', 'a.flac'), fakeFlac([]));
  writeFile(path.join(music, 'Bare', 'a.flac'), fakeFlac([]));
  writeFile(path.join(music, 'Bare', 'booklet.jpg'), JPEG);
  writeFile(path.join(music, 'Hollow', 'cover.jpg'), Buffer.alloc(0));

  const roots = [{ name: 'main', dir: music }];
  const data = path.join(dir, 'data');
  const pairing = new PairingStore(data);
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
  server.on('request', createApp({
    config: { publicBase: base, basePath: '/api/', serverName: 'Test NAS', appOrigins: [], roots },
    library: new Library([], new TagCache()),
    pairing,
    playlists: new PlaylistStore(data),
    secret: loadOrCreateSecret(data),
    now: () => clock,
  }));
  token = pairing.redeem(pairing.createCode().code, 'Phone')!.token;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  removeDir(dir);
});

describe('the other forms of a name', () => {
  it('come with a song when its tags carry them, and are left out when they do not', async () => {
    const { tracks } = await browse('main/Midori Vale/Night Market');
    expect(tracks[0]).toMatchObject({
      title: '紙の灯籠', artist: '緑の谷', album: '夜市', trackNumber: 1,
      titleRoman: 'Kami no Tourou', artistRoman: 'Midori no Tani', albumRoman: 'Yoichi',
      titleEnglish: 'Paper Lanterns', artistEnglish: 'Midori Vale', albumEnglish: 'Night Market', appleSongId: '9900112233',
    });
    expect(tracks[1]).toMatchObject({ title: 'Plain Song', artist: 'Midori Vale' });
    for (const key of ['titleRoman', 'artistRoman', 'albumRoman', 'titleEnglish', 'artistEnglish', 'albumEnglish', 'appleSongId']) {
      expect(tracks[1]).not.toHaveProperty(key);
    }
  });
});

describe('album covers', () => {
  it('finds cover before folder before front, whatever the case, and nothing else', async () => {
    const music = path.join(dir, 'music');
    expect(await findCover(path.join(music, 'Midori Vale', 'Night Market'))).toMatchObject({ type: 'image/jpeg', size: JPEG.length });
    expect(await findCover(path.join(music, 'Fronted'))).toMatchObject({ type: 'image/png', size: PNG.length });
    expect(await findCover(path.join(music, 'Bare'))).toBeNull();
    expect(await findCover(path.join(music, 'Hollow'))).toBeNull();
    expect(await findCover(path.join(music, 'no such folder'))).toBeNull();
    // A small copy is given only when asked for; without one, the full picture is.
    expect(await findCover(path.join(music, 'Fronted'), true)).toMatchObject({ type: 'image/png', size: PNG.length });
    writeFile(path.join(music, 'Midori Vale', 'Night Market', 'cover.small.jpg'), JPEG.subarray(0, JPEG.length - 1));
    expect(await findCover(path.join(music, 'Midori Vale', 'Night Market'), true)).toMatchObject({ type: 'image/jpeg', size: JPEG.length - 1 });
    expect(await findCover(path.join(music, 'Midori Vale', 'Night Market'))).toMatchObject({ type: 'image/jpeg', size: JPEG.length });
  });

  it('gives a folder with a cover an address that serves it without the token', async () => {
    const album = await browse('main/Midori Vale/Night Market');
    expect(album.cover).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/cover\?path=main%2FMidori%20Vale%2FNight%20Market&exp=\d+&sig=[0-9a-f]+$/);
    const reply = await call('GET', album.cover!);
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('image/jpeg');
    expect(reply.headers['cache-control']).toContain('max-age=86400');
    expect(reply.body.equals(JPEG)).toBe(true);
    const head = await call('HEAD', album.cover!);
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(JPEG.length));
    expect(head.body).toHaveLength(0);
  });

  it('says null for a folder without one, and for the list of roots', async () => {
    expect((await browse('main/Bare')).cover).toBeNull();
    expect((await browse('main/Midori Vale')).cover).toBeNull();
    expect((await browse('')).cover).toBeNull();
  });

  it('keeps the address the same through a day, so a browser keeps the picture', async () => {
    const before = (await browse('main/Fronted')).cover;
    clock += 5 * 60 * 60 * 1000;
    expect((await browse('main/Fronted')).cover).toBe(before);
    clock += 24 * 60 * 60 * 1000;
    expect((await browse('main/Fronted')).cover).not.toBe(before);
    // The earlier address still works: it was signed until the end of the day after it was made.
    expect((await call('GET', before!)).status).toBe(200);
    clock += 3 * 24 * 60 * 60 * 1000;
    expect((await call('GET', before!)).status).toBe(403);
    clock -= 4 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000;
  });

  it('refuses an address that was changed, and one for a folder with no cover', async () => {
    const cover = (await browse('main/Midori Vale/Night Market')).cover!;
    const url = new URL(cover);
    const bare = new URL(cover);
    bare.searchParams.set('path', 'main/Bare');
    expect((await call('GET', bare.toString())).status).toBe(403); // signed for another folder
    const tampered = new URL(cover);
    tampered.searchParams.set('sig', url.searchParams.get('sig')!.replace(/.$/, (c) => (c === '0' ? '1' : '0')));
    expect((await call('GET', tampered.toString())).status).toBe(403);
    const unsigned = new URL(cover);
    unsigned.searchParams.delete('sig');
    expect((await call('GET', unsigned.toString())).status).toBe(403);
    // A signature for an audio file is not one for a cover.
    const ticket = JSON.parse((await new Promise<Reply>((resolve, reject) => {
      const req = request(`${base}tracks/${Buffer.from('main/Bare/a.flac').toString('base64url')}/ticket`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    })).body.toString('utf8')) as { url: string };
    const audio = new URL(ticket.url);
    const crossed = new URL(cover);
    crossed.searchParams.set('path', Buffer.from('main/Bare/a.flac').toString('base64url'));
    crossed.searchParams.set('exp', audio.searchParams.get('exp')!);
    crossed.searchParams.set('sig', audio.searchParams.get('sig')!);
    expect((await call('GET', crossed.toString())).status).toBe(403);
  });
});
