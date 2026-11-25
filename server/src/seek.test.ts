/** Exact seeking: tickets that start at a FLAC frame, and the audio route's `at`. */
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TicketResponse } from '../../src/shared/api';
import { parseFrameHeader, readFlacIndex, streamHeader } from '../../src/shared/flac';
import type { Reader } from '../../src/shared/flac';
import { createApp } from './app';
import { PairingStore, loadOrCreateSecret } from './auth';
import { fileReader, flacSeek } from './flac-file';
import { Library } from './library';
import { TagCache } from './tag-cache';
import { FLAC_BLOCK, FLAC_RATE, removeDir, seekableFlac, tempDir, writeFile } from './test-helpers';
import { open } from 'node:fs/promises';

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const FRAMES = 300;
const flac = seekableFlac(FRAMES);
const TOTAL_SECONDS = (FRAMES * FLAC_BLOCK) / FLAC_RATE;
const id = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
const GULLS = id('main/Tin Harbor/Gulls.flac');
const MP3 = id('main/Tin Harbor/Named Wrong.mp3');
const BROKEN = id('main/Tin Harbor/Broken.flac');
/** A reader over bytes in memory. They are copied into a plain Uint8Array first: `slice` on a Buffer shares memory, and streamHeader relies on it copying. */
const memory = (bytes: Uint8Array): Reader => {
  const copy = Uint8Array.from(bytes);
  return async (offset, length) => copy.subarray(offset, offset + length);
};

let dir: string;
let server: Server;
let base: string;
let token: string;

function call(method: string, route: string, options: { token?: string; headers?: Record<string, string>; body?: string | object } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = request(route.startsWith('http') ? route : base + route, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function ticket(track: string, body?: string | object): Promise<TicketResponse> {
  const reply = await call('POST', `tracks/${track}/ticket`, { token, body });
  expect(reply.status).toBe(200);
  return JSON.parse(reply.body.toString('utf8')) as TicketResponse;
}

/** The plain audio URL of a track with `at` set to anything, valid or not. */
async function urlAt(track: string, at: string | number): Promise<string> {
  const plain = (await ticket(track)).url;
  expect(plain).not.toContain('at=');
  return `${plain}&at=${at}`;
}

beforeAll(async () => {
  dir = tempDir();
  const album = path.join(dir, 'music', 'Tin Harbor');
  writeFile(path.join(album, 'Gulls.flac'), flac.bytes);
  writeFile(path.join(album, 'Named Wrong.mp3'), flac.bytes);
  writeFile(path.join(album, 'Broken.flac'), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 31 + 7) & 0xff)));
  writeFile(path.join(album, 'Cut Short.flac'), flac.bytes.subarray(0, 30));

  const roots = [{ name: 'main', dir: path.join(dir, 'music') }];
  const data = path.join(dir, 'data');
  const pairing = new PairingStore(data);
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
  server.on('request', createApp({
    config: { publicBase: base, basePath: '/api/', serverName: 'Test NAS', appOrigins: [], roots },
    library: new Library([], new TagCache()),
    pairing,
    secret: loadOrCreateSecret(data),
  }));
  token = pairing.redeem(pairing.createCode().code, 'Phone')!.token;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  removeDir(dir);
});

describe('the file reader', () => {
  it('reads at offsets, and gives fewer bytes at the end of the file', async () => {
    const handle = await open(path.join(dir, 'music', 'Tin Harbor', 'Gulls.flac'), 'r');
    try {
      const read = fileReader(handle);
      const size = flac.bytes.length;
      expect(Buffer.from(await read(0, 4)).toString()).toBe('fLaC');
      expect(Buffer.from(await read(100, 50)).equals(flac.bytes.subarray(100, 150))).toBe(true);
      expect(Buffer.from(await read(size - 10, 64)).equals(flac.bytes.subarray(size - 10))).toBe(true);
      expect(await read(size, 10)).toHaveLength(0);
      expect(await read(size + 1000, 10)).toHaveLength(0);
      expect(await read(0, 0)).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });
});

describe('a ticket', () => {
  it('is for the whole file with no body, an empty body, {} or fromSeconds 0', async () => {
    for (const body of [undefined, '', '  \n', {}, { fromSeconds: 0 }, { other: true }]) {
      const reply = await ticket(GULLS, body);
      expect(reply.url).toMatch(new RegExp(`^${base}tracks/${GULLS}/audio\\?exp=\\d+&sig=[0-9a-f]{64}$`));
      expect(reply).toMatchObject({ exactSeek: true, startSeconds: 0, totalSeconds: TOTAL_SECONDS });
      expect(typeof reply.expiresAt).toBe('string');
    }
    const whole = await call('GET', (await ticket(GULLS)).url);
    expect(whole.status).toBe(200);
    expect(whole.body.equals(flac.bytes)).toBe(true);
  });

  it('starts at the frame holding fromSeconds', async () => {
    const fromSeconds = 12.34;
    const frame = Math.floor((fromSeconds * FLAC_RATE) / FLAC_BLOCK);
    const reply = await ticket(GULLS, { fromSeconds });
    expect(new URL(reply.url).searchParams.get('at')).toBe(String(flac.offsets[frame]));
    expect(reply.url).toMatch(/\/audio\?exp=\d+&sig=[0-9a-f]{64}&at=\d+$/);
    expect(reply.exactSeek).toBe(true);
    expect(reply.totalSeconds).toBe(TOTAL_SECONDS);
    expect(reply.startSeconds).toBe((frame * FLAC_BLOCK) / FLAC_RATE);
    expect(reply.startSeconds).toBeLessThanOrEqual(fromSeconds);
    expect(fromSeconds - reply.startSeconds).toBeLessThan(FLAC_BLOCK / FLAC_RATE);
  });

  it('lands on the right frame all along the file', async () => {
    for (const frame of [1, 2, 57, 150, 298, 299]) {
      // The frame's first sample, its last, and one in between.
      for (const sample of [frame * FLAC_BLOCK, frame * FLAC_BLOCK + FLAC_BLOCK - 1, frame * FLAC_BLOCK + 1000]) {
        const reply = await ticket(GULLS, { fromSeconds: (sample + 0.5) / FLAC_RATE });
        expect(new URL(reply.url).searchParams.get('at')).toBe(String(flac.offsets[frame]));
        expect(reply.startSeconds).toBe((frame * FLAC_BLOCK) / FLAC_RATE);
      }
    }
  });

  it('is for the whole file when fromSeconds is inside the first frame', async () => {
    const reply = await ticket(GULLS, { fromSeconds: 0.05 });
    expect(reply.url).not.toContain('at=');
    expect(reply.startSeconds).toBe(0);
  });

  it('starts at the last frame when fromSeconds is past the end', async () => {
    for (const fromSeconds of [TOTAL_SECONDS, TOTAL_SECONDS + 1, 99999]) {
      const reply = await ticket(GULLS, { fromSeconds });
      expect(new URL(reply.url).searchParams.get('at')).toBe(String(flac.offsets[FRAMES - 1]));
      expect(reply.startSeconds).toBe(((FRAMES - 1) * FLAC_BLOCK) / FLAC_RATE);
    }
  });

  it('is plain for a file that is not FLAC by name, or not FLAC inside', async () => {
    for (const track of [MP3, BROKEN, id('main/Tin Harbor/Cut Short.flac')]) {
      for (const body of [undefined, { fromSeconds: 12.34 }]) {
        const reply = await ticket(track, body);
        expect(reply.url).toMatch(/\/audio\?exp=\d+&sig=[0-9a-f]{64}$/);
        expect(reply).toMatchObject({ exactSeek: false, startSeconds: 0, totalSeconds: null });
      }
    }
    expect(await flacSeek(path.join(dir, 'music', 'Tin Harbor', 'Gone.flac'), 5)).toEqual({ exactSeek: false, totalSeconds: null, startSeconds: 0, at: null });
  });

  it('answers 400 for a body that is not an object, or a fromSeconds that is not a time', async () => {
    for (const body of ['[]', '"12"', '5', 'null', '{ nope', '{"fromSeconds":1e999}', { fromSeconds: '12' }, { fromSeconds: -1 }, { fromSeconds: null }, { fromSeconds: [3] }]) {
      const reply = await call('POST', `tracks/${GULLS}/ticket`, { token, body });
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body.toString('utf8'))).toEqual({ error: 'bad-request' });
    }
    expect((await call('POST', `tracks/${GULLS}/ticket`, { token, body: { fromSeconds: 1, pad: 'x'.repeat(20_000) } })).status).toBe(413);
    expect((await call('POST', `tracks/${GULLS}/ticket`, { body: { fromSeconds: 1 } })).status).toBe(401);
    expect((await call('POST', `tracks/${id('main/Tin Harbor/Missing.flac')}/ticket`, { token, body: { fromSeconds: 1 } })).status).toBe(404);
  });
});

describe('audio from a frame', () => {
  const FRAME = 132;
  const at = flac.offsets[FRAME];
  const tail = flac.bytes.subarray(at);
  const size = 42 + tail.length;
  let url: string;
  let stream: Buffer;

  beforeAll(async () => {
    url = (await ticket(GULLS, { fromSeconds: (FRAME * FLAC_BLOCK + 10) / FLAC_RATE })).url;
    expect(new URL(url).searchParams.get('at')).toBe(String(at));
    const original = (await readFlacIndex(memory(flac.bytes), flac.bytes.length))!;
    stream = Buffer.concat([streamHeader(original, FRAME * FLAC_BLOCK), tail]);
    expect(stream).toHaveLength(size);
  });

  it('is a FLAC header, then the file from that frame on', async () => {
    const reply = await call('GET', url);
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('audio/flac');
    expect(reply.headers['accept-ranges']).toBe('bytes');
    expect(reply.headers['cache-control']).toBe('private, max-age=3600');
    expect(reply.headers['content-length']).toBe(String(size));
    expect(reply.body.subarray(42).equals(tail)).toBe(true);
    expect(reply.body.equals(stream)).toBe(true);

    // Read back as a file of its own: a shorter stream whose first frame still says where it was in the song.
    const index = (await readFlacIndex(memory(reply.body), reply.body.length))!;
    expect(index.audioStart).toBe(42);
    expect(index.totalSamples).toBe(flac.totalSamples - FRAME * FLAC_BLOCK);
    expect(index).toMatchObject({ sampleRate: FLAC_RATE, channels: 2, bitsPerSample: 16, maxBlock: FLAC_BLOCK });
    expect([...index.streamInfo.subarray(18)].every((byte) => byte === 0)).toBe(true);
    expect(parseFrameHeader(reply.body, 42, index)).toEqual({ sample: FRAME * FLAC_BLOCK, blockSize: FLAC_BLOCK });
  });

  it.each([
    ['inside the header', 'bytes=10-19', 10, 19],
    ['the first byte', 'bytes=0-0', 0, 0],
    ['the whole header', 'bytes=0-41', 0, 41],
    ['across byte 42', 'bytes=30-60', 30, 60],
    ['from the last header byte', 'bytes=41-42', 41, 42],
    ['the first body byte on', 'bytes=42-141', 42, 141],
    ['inside the body', 'bytes=1000-1999', 1000, 1999],
    ['an open end from the header', 'bytes=40-', 40, size - 1],
    ['an open end from the body', `bytes=${size - 300}-`, size - 300, size - 1],
    ['a suffix', 'bytes=-100', size - 100, size - 1],
    ['a suffix longer than the stream', `bytes=-${size + 500}`, 0, size - 1],
    ['an end past the stream', `bytes=${size - 5}-${size + 500}`, size - 5, size - 1],
  ])('serves a range %s', async (_, range, start, end) => {
    const reply = await call('GET', url, { headers: { range } });
    expect(reply.status).toBe(206);
    expect(reply.headers['content-range']).toBe(`bytes ${start}-${end}/${size}`);
    expect(reply.headers['content-length']).toBe(String(end - start + 1));
    expect(reply.headers['content-type']).toBe('audio/flac');
    expect(reply.body.equals(stream.subarray(start, end + 1))).toBe(true);
  });

  it('answers 416 for a range past the stream, counted over the stream and not the file', async () => {
    for (const range of [`bytes=${size}-`, `bytes=${size + 10}-${size + 20}`, 'bytes=-0']) {
      const reply = await call('GET', url, { headers: { range } });
      expect(reply.status).toBe(416);
      expect(reply.headers['content-range']).toBe(`bytes */${size}`);
    }
    // The last byte of the stream is there; the same offset counted over the file would not be.
    expect((await call('GET', url, { headers: { range: `bytes=${size - 1}-` } })).body.equals(stream.subarray(size - 1))).toBe(true);
  });

  it('answers HEAD with the headers alone', async () => {
    const head = await call('HEAD', url);
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(size));
    expect(head.headers['content-type']).toBe('audio/flac');
    expect(head.headers['accept-ranges']).toBe('bytes');
    expect(head.body).toHaveLength(0);

    const ranged = await call('HEAD', url, { headers: { range: 'bytes=30-60' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers['content-range']).toBe(`bytes 30-60/${size}`);
    expect(ranged.headers['content-length']).toBe('31');
    expect(ranged.body).toHaveLength(0);
  });

  it('serves any frame, the first and the last among them', async () => {
    for (const frame of [0, 1, FRAMES - 1]) {
      const reply = await call('GET', await urlAt(GULLS, flac.offsets[frame]));
      expect(reply.status).toBe(200);
      expect(reply.body.subarray(42).equals(flac.bytes.subarray(flac.offsets[frame]))).toBe(true);
      const index = (await readFlacIndex(memory(reply.body), reply.body.length))!;
      expect(index.totalSamples).toBe(flac.totalSamples - frame * FLAC_BLOCK);
    }
  });

  it('answers 400 when no frame starts at the offset', async () => {
    const fileSize = flac.bytes.length;
    for (const bad of [
      at + 1, at - 1, at + 300,         // inside a frame
      flac.audioStart - 1, 0, 4, 42,     // before the audio
      fileSize, fileSize + 10, fileSize - 3, // at or past the end, or too near it to hold a header
      'abc', '-5', '1.5', '', ' 100', '1e3', '0x10', '9'.repeat(16),
    ]) {
      const reply = await call('GET', await urlAt(GULLS, bad));
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body.toString('utf8'))).toEqual({ error: 'bad-request' });
      expect((await call('HEAD', await urlAt(GULLS, bad))).status).toBe(400);
    }
  });

  it('answers 400 for a file that is not FLAC, though a frame starts there', async () => {
    expect((await call('GET', await urlAt(MP3, at))).status).toBe(400);
    expect((await call('GET', await urlAt(BROKEN, 100))).status).toBe(400);
    // Without `at` both are served as they are.
    const plain = await call('GET', (await ticket(MP3)).url);
    expect(plain.status).toBe(200);
    expect(plain.headers['content-type']).toBe('audio/mpeg');
    expect(plain.body.equals(flac.bytes)).toBe(true);
  });

  it('still answers 403 for a tampered or missing signature', async () => {
    const good = new URL(url);
    const sig = good.searchParams.get('sig')!;
    const flipped = new URL(url);
    flipped.searchParams.set('sig', (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1));
    const later = new URL(url);
    later.searchParams.set('exp', String(Number(good.searchParams.get('exp')) + 60));
    const unsigned = new URL(url);
    unsigned.searchParams.delete('sig');
    for (const bad of [flipped, later, unsigned]) {
      const reply = await call('GET', bad.href);
      expect(reply.status).toBe(403);
      expect(JSON.parse(reply.body.toString('utf8'))).toEqual({ error: 'bad-ticket' });
    }
    // A ticket for one track doesn't open another, with or without `at`.
    expect((await call('GET', url.replace(GULLS, MP3))).status).toBe(403);
    // A bad signature is refused before `at` is looked at.
    flipped.searchParams.set('at', 'abc');
    expect((await call('GET', flipped.href)).status).toBe(403);
  });
});
