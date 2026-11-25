# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

太鼓 Taiko is a browser music player that shows timed lyrics, filling each word as it is sung. It plays files the person picks on their device (nothing is uploaded) and can stream a library from an optional NAS server. It is laid out like the owner's Blu-ray player, Seikou (`../seikou`): a static Vite + React + TypeScript app in `src/`, and a dependency-free Node server in `server/`.

## Commands

```sh
npm run dev            # the player
npm test               # vitest: player and server
npm run test:e2e       # Playwright (tests/e2e): the player in Chromium and Firefox, against the dev server and the built NAS server
npm run typecheck      # tsc -b over the app, node and server projects
npm run build          # typecheck, then the static site in dist/
npm run server:build   # esbuild bundle: server/dist/server.mjs
npm run server:dev     # build and run the server on :4193 against fixtures/music (not in the repo)
npm run server:deploy  # the owner's deploy to a NAS, over ssh or run on the NAS itself (server/deploy/deploy.sh; settings in .env.local)
```

One test file: `npx vitest run src/lyrics/lyrics.test.ts`. One browser test: `npx playwright test tests/e2e/seek.spec.ts --project=chromium`. The first run needs `npx playwright install chromium firefox`.

The browser tests use made-up songs: `tests/e2e/fixtures.ts` writes a tone whose pitch rises steadily as an uncompressed FLAC, so a test can hear where the audio really is (`expectInTime` in `helpers.ts`) and compare it with the position shown. They read that position through `window.taikoStore`, which only the dev build sets.

## Deploys

- **The player** is the classic Cloudflare Pages project `taiko-player` (https://taiko-player.pages.dev). `.github/workflows/ci.yml` typechecks, unit-tests and browser-tests every push and pull request, then deploys `main` to the site and `beta` to `beta.taiko-player.pages.dev`. `preview.yml` deploys any other branch by hand. Both need the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- Create Pages projects with `wrangler pages project create <name> --force`. Without `--force`, current Wrangler deploys a Worker instead and rewrites `package.json` and `vite.config.ts` for Workers.
- **The NAS server** is deployed by hand with `npm run server:deploy`; CI doesn't touch it. A NAS only answers the production site (its `APP_URL`), so a beta or preview deploy can't use one unless its address is added there.

## Architecture

- `src/shared/` is used by both the player and the server, so it touches neither the DOM nor Node. `api.ts` is the HTTP contract (routes, types, the lyrics-naming rule); change it first when a feature crosses the boundary. `tags.ts` reads FLAC and ID3 tags (a FLAC file is walked block by block through a reader, so tags behind a large cover picture are found, and an `.m4a` file atom by atom): the names, a reading in Latin letters from the `*SORT` tags, an English name from `*_EN`, and `APPLE_SONG_ID`. `flac.ts` is exact seeking: it finds the FLAC frame at a time and builds the header of a stream that begins there.
- `src/lyrics/`: everything is TTML as Apple Music writes it. `ttml.ts` opens a file (Apple JSON wrapper, TTML, or LRC converted by `lrc.ts`) into a `LyricsSource` (the XML document plus its wrapper) and builds the `Song` model from it. `merge.ts` combines versions of one song (same timed lines, different head extras) and serializes the result. Tests need a DOM and ask for jsdom with a `@vitest-environment jsdom` comment.
- `src/apple/catalog.ts`: Apple's public iTunes Search API, for names, art and IDs. It tries `fetch` and falls back to JSONP, because Apple's CORS header comes and goes.
- `src/library/tracks.ts`: the `Track` type (a device file or a NAS track) and sorting a batch of picked files into tracks and lyrics. `kept.ts` keeps copies of picked files in IndexedDB, so they are listed again on the next visit. `offline.ts` keeps NAS songs there too (audio and lyrics), for the albums and playlists the listener chose to keep on the device; `PlayerStore.select` plays a kept song from its copy, like a device file, and an album kept on the device opens from what was kept when the NAS can't be reached.
- `src/shared/playlists.ts`: the stored shape of a playlist, and `reconcile`, which brings a device's playlists and the NAS's together. The NAS keeps a set for each user, shared by that user's devices (`GET`/`PUT playlists`, refused with 409 when sent from an older version); `PlayerStore.syncPlaylists` runs at the start of a visit, when the page comes back into view and after a change. A playlist is private, `public` (other users see and play it) or `collaborative` (they change its songs too, through `PUT playlists/shared/:owner/:id`); other people's come from `GET playlists/shared`. A server without the routes leaves playlists in the browser.
- **Listening**: the player counts the seconds of a NAS song really heard (`PlayerStore.noteHeard`) and tells the NAS once, at half the song or four minutes (`POST plays`); a play that can't be sent waits in localStorage. Favourites and history are the user's alone, and only exist on a NAS that has users.
- **Users**: the NAS has an owner (id `owner`) and the family and friends the owner adds from its command line (`user add`, `users`, `user rename`, `user remove`). There are no passwords: an invite is made for a user (`invite --user`), a device belongs to its invite's user, and a paired device can make an invite for another device of the same user (`POST invite`). Everyone sees the whole library.
- `public/sw.js`: a service worker that keeps the page and its scripts, styles and fonts, so the built site opens with no connection. Only the built site registers it; it never answers for a NAS or for Apple.
- `src/nas/client.ts`: pairing (stored under `taiko:nas` in localStorage) and the API calls.
- `src/player/queue.ts`: the order a queue plays in (as listed or shuffled, kept beside the list, not by reordering it) and where Next and Previous lead under each repeat setting. Pure, and tested. It also holds the changes a listener makes to what is to come (play next, add, move, remove); once they make one, `PlayerStore.arrange` puts the list itself in play order, and the saved session keeps that order.
- `src/player/persist.ts`: what the browser keeps between visits, all in localStorage and read defensively: settings, each song's lyric timing, playlists (per NAS) and the last session. Only NAS songs are stored, without their lyrics list or cover address; a stored song is marked `stale` and looked up again in its folder before it plays.
- `src/player/route.ts`: the paths in the address bar (`/nas/folders/<path>`, `/nas/play/<song path>?t=`), for NAS folders and songs only. The store writes them (`openSongs`, `browse`, `select`) and follows them (`applyRoute`, from a link or the back button). Pages serves the app at any path. A path names a place on whichever NAS the device is paired with, and breaks if the file moves, unless the NAS has a record of the move (`server/src/moved.ts`): there are no stable ids yet.
- `src/player/store.ts`: `PlayerStore`, an external store read with `useSyncExternalStore`. There is no state library. It owns the one `<audio>` element, the queue (`playFrom` makes a list the queue; `select` plays a song in it) and the playlists. Anything that changes every frame (the word fill in `ui/LyricsView.tsx`, the seek bar in `ui/TransportBar.tsx`) reads `store.audio.currentTime` in a `requestAnimationFrame` loop and writes the DOM directly, outside React's rendering.
- `server/src/`: `config.ts` (env), `paths.ts` (turns a track id or a browse path into a file inside a root, and lists a folder), `library.ts` (the album scan of the `LIBRARY_SCAN` roots, and song search), `auth.ts` (users, codes, device tokens, signed audio tickets), `playlists.ts` (each user's playlists, in `DATA_DIR/playlists.json`), `listening.ts` (each user's favourites in `DATA_DIR/favourites.json`, and a line per song played in `DATA_DIR/history/<user>.jsonl`, from which `GET history` makes the latest plays, the most played and the albums played lately), `moved.ts` (where songs went when an album was replaced: it reads `<root>/.ringobushi/replaced.jsonl`, written by Ringobushi; `POST moved` answers for ids whose file is gone, and the player then points playlists, the saved session and old links at the fresh copy), `ranges.ts` (ranged audio), `app.ts` (the request handler), `main.ts` (serve, `invite`, `devices`, `unpair`, `users`, `user`). The player browses the NAS by folder (`GET browse`); a track's id is the base64url of its path under a root. The pairing store is re-read on every request, which is how the subcommands work against a running server.

## Constraints

- **The NAS's album library is built only from the roots named in `LIBRARY_SCAN`** (`off`, `on`, or root names): the owner's rule is that only folders of fully tagged albums go in it; every other root stays in the folder browser. An album is a folder that directly holds songs. The player's first screen (`src/ui/Library.tsx`) lists albums and artists from `GET library`, opens an album through `browse`, and searches songs with `GET library/search`. The album grid asks for covers with `size=small`, which serves a folder's `cover.small.jpg` when there is one.
- **The browser is never asked to seek a FLAC file.** Safari seeks FLAC roughly and then reports the time asked for, which puts the lyrics out of time. `PlayerStore.seek` instead plays a new stream that begins at the frame (a cut `Blob` for a device file, a ticket with `fromSeconds` for the NAS), and everything reads the time from `store.position()`, never `audio.currentTime`. Other formats still seek natively.
- **Tag names and file naming are agreed with Ringobushi**, the owner's separate project that fills a NAS folder with tagged albums (`Artist/[date] Album/NN. Title.flac`, one `<track file name>.json` of lyrics beside each track, `cover.jpg` per album). It keeps `TITLE`/`ARTIST`/`ALBUM`, the `*SORT` and `*_EN` tags, `APPLE_SONG_ID` and that lyrics naming stable; don't change how Taiko reads them without checking with the owner.
- **Taiko never fetches lyrics.** People bring their own files, and the NAS serves only files that sit beside the audio. Apple's catalog is used for names, art and IDs only.
- **Nothing the person picks is uploaded.** Local files are read in the browser, and the copies kept for the next visit stay in that browser.
- **The server has no runtime dependencies** and never writes to the library; it writes only `DATA_DIR`. Every path from a request (a track id, a browse path) goes through the resolver in `paths.ts`, which refuses `..`, skipped names and anything whose real path is outside its root.
- **Real artists, titles and lyrics never go into the repo**: tests and fixtures use made-up names. `fixtures/local` and `fixtures/music` are for real files and are not committed.
- TypeScript is strict, with `noUnusedLocals`/`noUnusedParameters` and `verbatimModuleSyntax` (use `import type`). Relative imports have no file extension.
- The UI's copy is plain and in sentence case; a button says what it does.
- **The look comes from the drum** (the comment at the top of `src/ui/styles.css`): indigo for the ground, the drumhead's hide for sung words and primary text, brass for "now" (the sweep's leading edge, the open song, focus), and vermilion only for notices. The lyric filling as it is sung is the one loud thing. Text buttons and fields are rectangles; circles are kept for Play, which is drawn as the drumhead with its ring of tacks, and for icon buttons. Lyrics and headings are set in Shippori Mincho, controls in Zen Kaku Gothic New.
