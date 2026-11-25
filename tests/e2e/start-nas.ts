/**
 * Starts the NAS server for the browser tests: makes a small library of made-up songs under .cache/e2e, clears the
 * server's data, and runs the built bundle in this process. Playwright starts it (playwright.config.ts) after
 * `npm run server:build`. Node runs this file as it is, so its imports name their `.ts` files.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { COVER_PNG, NAS, lyrics, toneFlac } from './fixtures.ts';

rmSync('.cache/e2e', { recursive: true, force: true });
const album = path.join(NAS.library, 'Midori Vale', 'Night Market');
mkdirSync(album, { recursive: true });
mkdirSync(path.join(NAS.library, 'Empty'), { recursive: true });
mkdirSync(NAS.data, { recursive: true });

// File names sort "2" before "10"; the tags name the songs.
writeFileSync(path.join(album, '2 - lanterns.flac'), toneFlac({
  seconds: 50, title: 'Paper Lanterns', artist: 'Midori Vale', album: 'Night Market', track: 2, tags: ['ALBUMARTIST=Midori Vale', 'DATE=2026-10-14'],
}));
writeFileSync(path.join(album, '2 - lanterns.json'), lyrics.plain);
writeFileSync(path.join(album, '2 - lanterns.ja-Latn.json'), lyrics.roman);
writeFileSync(path.join(album, '2 - lanterns_en.json'), lyrics.english);
// A song named in Japanese, with its reading, its English name and an Apple Music id in its tags, and no lyrics.
writeFileSync(path.join(album, '10 - harbour.flac'), toneFlac({
  seconds: 20, title: '港の灯', artist: '緑の谷', album: 'Night Market', track: 10,
  tags: ['TITLESORT=Minato no Akari', 'ARTISTSORT=Midori no Tani', 'TITLE_EN=Harbour Lights', 'ARTIST_EN=Midori Vale', 'APPLE_SONG_ID=9900112244', 'ALBUMARTIST=Midori Vale', 'DATE=2026-10-14'],
}));
writeFileSync(path.join(album, 'untagged.flac'), toneFlac({ seconds: 5 }));
writeFileSync(path.join(album, 'cover.png'), COVER_PNG);
writeFileSync(path.join(album, 'booklet.txt'), 'not a song');
// A second album for the library: named in Japanese with its reading and English name, and no cover.
const tide = path.join(NAS.library, 'Tin Harbor', 'Low Tide');
mkdirSync(tide, { recursive: true });
writeFileSync(path.join(tide, '1 - shoals.flac'), toneFlac({
  seconds: 8, title: 'Shoals', artist: 'Tin Harbor', album: '引き潮', track: 1, tags: ['ALBUMSORT=Hikishio', 'ALBUM_EN=Low Tide', 'DATE=2024'],
}));
// The record of an album that was replaced: a song that used to be in a folder that is gone now is this one.
mkdirSync(path.join(NAS.library, '.ringobushi'), { recursive: true });
writeFileSync(path.join(NAS.library, '.ringobushi', 'replaced.jsonl'), `${JSON.stringify({
  event: 'replaced', oldRoot: 'Music', oldPath: 'Old Shelf/Night Market/02 lanterns.flac', newPath: 'Midori Vale/Night Market/2 - lanterns.flac',
})}\n`);

Object.assign(process.env, {
  PORT: String(NAS.port),
  PUBLIC_BASE: NAS.base,
  APP_URL: NAS.app,
  LIBRARY_ROOTS: `Music=${NAS.library}`,
  LIBRARY_SCAN: 'Music',
  // Every test pairs from the same address; the suite makes more pairings in ten minutes than a household would.
  PAIR_ATTEMPTS: '200',
  DATA_DIR: NAS.data,
  SERVER_NAME: 'Test NAS',
});
// A path in a variable: the bundle is built just before this runs, and has no types to check.
const bundle = '../../server/dist/server.mjs';
await import(bundle);
