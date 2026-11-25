# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

太鼓 Taiko is a browser music player that shows timed lyrics, filling each word as it is sung. It plays files the person picks on their device (nothing is uploaded) and can stream a library from an optional NAS server. It is laid out like the owner's Blu-ray player, Seikou (`../seikou`): a static Vite + React + TypeScript app in `src/`, and a dependency-free Node server in `server/`.

## Commands

```sh
npm run dev            # the player
npm test               # vitest: player and server
npm run typecheck      # tsc -b over the app, node and server projects
npm run build          # typecheck, then the static site in dist/
npm run server:build   # esbuild bundle: server/dist/server.mjs
npm run server:dev     # build and run the server on :4193 against fixtures/music (not in the repo)
npm run server:deploy  # the owner's deploy to a NAS over ssh (server/deploy/deploy.sh; settings in .env.local)
```

One test file: `npx vitest run src/lyrics/lyrics.test.ts`.

## Deploys

- **The player** is the classic Cloudflare Pages project `taiko-player` (https://taiko-player.pages.dev). `.github/workflows/ci.yml` typechecks and tests every push and pull request, then deploys `main` to the site and `beta` to `beta.taiko-player.pages.dev`. `preview.yml` deploys any other branch by hand. Both need the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- Create Pages projects with `wrangler pages project create <name> --force`. Without `--force`, current Wrangler deploys a Worker instead and rewrites `package.json` and `vite.config.ts` for Workers.
- **The NAS server** is deployed by hand with `npm run server:deploy`; CI doesn't touch it. A NAS only answers the production site (its `APP_URL`), so a beta or preview deploy can't use one unless its address is added there.

## Architecture

- `src/shared/` is used by both the player and the server, so it touches neither the DOM nor Node. `api.ts` is the HTTP contract (routes, types, the lyrics-naming rule); change it first when a feature crosses the boundary. `tags.ts` reads FLAC and ID3 tags from a file's first bytes. `flac.ts` is exact seeking: it finds the FLAC frame at a time and builds the header of a stream that begins there.
- `src/lyrics/`: everything is TTML as Apple Music writes it. `ttml.ts` opens a file (Apple JSON wrapper, TTML, or LRC converted by `lrc.ts`) into a `LyricsSource` (the XML document plus its wrapper) and builds the `Song` model from it. `merge.ts` combines versions of one song (same timed lines, different head extras) and serializes the result. Tests need a DOM and ask for jsdom with a `@vitest-environment jsdom` comment.
- `src/apple/catalog.ts`: Apple's public iTunes Search API, for names, art and IDs. It tries `fetch` and falls back to JSONP, because Apple's CORS header comes and goes.
- `src/library/tracks.ts`: the `Track` type (a device file or a NAS track) and sorting a batch of picked files into tracks and lyrics.
- `src/nas/client.ts`: pairing (stored under `taiko:nas` in localStorage) and the API calls.
- `src/player/store.ts`: `PlayerStore`, an external store read with `useSyncExternalStore`. There is no state library. It owns the one `<audio>` element. Anything that changes every frame (the word fill in `ui/LyricsView.tsx`, the seek bar in `ui/TransportBar.tsx`) reads `store.audio.currentTime` in a `requestAnimationFrame` loop and writes the DOM directly, outside React's rendering.
- `server/src/`: `config.ts` (env), `paths.ts` (turns a track id or a browse path into a file inside a root, and lists a folder), `library.ts` (the tag scan, off unless `LIBRARY_SCAN=on`), `auth.ts` (codes, device tokens, signed audio tickets), `ranges.ts` (ranged audio), `app.ts` (the request handler), `main.ts` (serve, `invite`, `devices`, `unpair`). The player browses the NAS by folder (`GET browse`); a track's id is the base64url of its path under a root. The pairing store is re-read on every request, which is how the subcommands work against a running server.

## Constraints

- **The NAS's tag-based library is on hold** until the owner decides how metadata should work: the player uses the folder browser only. Don't build on `GET library` without asking.
- **The browser is never asked to seek a FLAC file.** Safari seeks FLAC roughly and then reports the time asked for, which puts the lyrics out of time. `PlayerStore.seek` instead plays a new stream that begins at the frame (a cut `Blob` for a device file, a ticket with `fromSeconds` for the NAS), and everything reads the time from `store.position()`, never `audio.currentTime`. Other formats still seek natively.
- **Taiko never fetches lyrics.** People bring their own files, and the NAS serves only files that sit beside the audio. Apple's catalog is used for names, art and IDs only.
- **Nothing the person picks is uploaded.** Local files are read in the browser.
- **The server has no runtime dependencies** and never writes to the library; it writes only `DATA_DIR`. Every path from a request (a track id, a browse path) goes through the resolver in `paths.ts`, which refuses `..`, skipped names and anything whose real path is outside its root.
- **Real artists, titles and lyrics never go into the repo**: tests and fixtures use made-up names. `fixtures/local` and `fixtures/music` are for real files and are not committed.
- TypeScript is strict, with `noUnusedLocals`/`noUnusedParameters` and `verbatimModuleSyntax` (use `import type`). Relative imports have no file extension.
- The UI's copy is plain and in sentence case; a button says what it does.
