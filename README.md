# Taiko

Taiko (太鼓, the drum) is a music player that runs in your browser and shows a song's lyrics in time with it, filling each word as it is sung. It plays your own audio files with your own lyrics files. Nothing is uploaded: the files are read on your device, and an optional server on your own NAS can stream a whole library to it.

## Get started

1. Open [taiko-player.pages.dev](https://taiko-player.pages.dev), or run the player yourself (`npm install`, then `npm run dev`).
2. Choose audio files, with their lyrics if you have them. Or choose a whole folder.
3. Or pair the player with a NAS server, if you or a friend run one.

It is hosted at [taiko-player.pages.dev](https://taiko-player.pages.dev), deployed from `main` by CI. `npm run build` makes the same static site in `dist/`, which any static host can serve.

## Lyrics

Taiko reads three formats:

- **Apple Music lyrics JSON** (word-timed, with romanizations and translations when the file has them).
- **TTML**, the format inside that JSON.
- **LRC**, including the "enhanced" kind with word tags.

Name a lyrics file like its song and they pair up by themselves: `Song.flac` takes `Song.json`, `Song.ttml` or `Song.lrc`, and versions such as `Song.ja-Latn.json` or `Song_en.json`. Several versions of one song (the plain lyrics, a romanization, a translation) are combined, and **Download lyrics** saves the combination as one file.

When a lyrics file carries an Apple Music song ID, Taiko asks Apple's public catalog for the song's name, artist and cover. The search at the top finds a song by name. Only the ID and what you type in the search go to Apple; Taiko never fetches lyrics from anywhere.

## NAS

The NAS server runs in Docker next to your music, behind your own HTTPS address. A paired device browses your music folders, streams the audio and gets the lyrics files that sit beside the songs. A device pairs with it once, through an invite link the owner makes. See [docs/self-hosting.md](docs/self-hosting.md).

## Develop

| Command | What it does |
|---|---|
| `npm run dev` | The player, with hot reload. |
| `npm test` | Unit tests (player and server). |
| `npm run test:e2e` | Browser tests in Chromium and Firefox (run `npx playwright install chromium firefox` once first). |
| `npm run typecheck` | TypeScript, every part. |
| `npm run build` | Typecheck, then the static site in `dist/`. |
| `npm run server:build` | Bundles the server to `server/dist/server.mjs`. |
| `npm run server:dev` | Builds and runs the server on port 4193 against `fixtures/music` (make that folder and put a few songs in it; it is not in the repo). `node server/dev.mjs invite` then prints a pairing link for the dev player. |
| `npm run server:deploy` | Builds the server image and ships it to a NAS over ssh (see [docs/self-hosting.md](docs/self-hosting.md)). |

[CLAUDE.md](CLAUDE.md) describes how the project is laid out.

## Not there yet

- Tags are read from FLAC and ID3 (MP3) files. Other formats show their file name.
- No offline install: there is a web app manifest but no service worker.
- The NAS is browsed by folder. Songs are named by their tags, but there is no library sorted by artist and album: the server can scan for one (`LIBRARY_SCAN`), and the player has no screen for it yet.
- The NAS is reached over HTTPS only. There are no typed pairing codes without the address, no QR codes and no WebRTC route.
- The player remembers the NAS pairing, but not the files you picked: choose them again after a reload.
- All rights reserved for now: the project has no licence yet, so the code is public to read but not licensed for reuse.
