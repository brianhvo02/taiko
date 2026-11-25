/**
 * Starts the NAS server for the browser tests: makes a small library of made-up songs under .cache/e2e, clears the
 * server's data, and runs the built bundle in this process. Playwright starts it (playwright.config.ts) after
 * `npm run server:build`. Node runs this file as it is, so its imports name their `.ts` files.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NAS, lyrics, toneFlac } from './fixtures.ts';

rmSync('.cache/e2e', { recursive: true, force: true });
const album = path.join(NAS.library, 'Midori Vale', 'Night Market');
mkdirSync(album, { recursive: true });
mkdirSync(path.join(NAS.library, 'Empty'), { recursive: true });
mkdirSync(NAS.data, { recursive: true });

// File names sort "2" before "10"; the tags name the songs.
writeFileSync(path.join(album, '2 - lanterns.flac'), toneFlac({ seconds: 50, title: 'Paper Lanterns', artist: 'Midori Vale', album: 'Night Market', track: 2 }));
writeFileSync(path.join(album, '2 - lanterns.json'), lyrics.plain);
writeFileSync(path.join(album, '2 - lanterns.ja-Latn.json'), lyrics.roman);
writeFileSync(path.join(album, '2 - lanterns_en.json'), lyrics.english);
writeFileSync(path.join(album, '10 - harbour.flac'), toneFlac({ seconds: 20, title: 'Harbour Lights', artist: 'Midori Vale', album: 'Night Market', track: 10 }));
writeFileSync(path.join(album, 'untagged.flac'), toneFlac({ seconds: 5 }));
writeFileSync(path.join(album, 'cover.jpg'), 'not a song');

Object.assign(process.env, {
  PORT: String(NAS.port),
  PUBLIC_BASE: NAS.base,
  APP_URL: NAS.app,
  LIBRARY_ROOTS: `Music=${NAS.library}`,
  DATA_DIR: NAS.data,
  SERVER_NAME: 'Test NAS',
});
// A path in a variable: the bundle is built just before this runs, and has no types to check.
const bundle = '../../server/dist/server.mjs';
await import(bundle);
