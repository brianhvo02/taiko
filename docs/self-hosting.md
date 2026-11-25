# Run your own server

The player is a static web app. Your music stays on your machine; the NAS server lets paired devices browse its folders, streams the audio over HTTPS and serves the lyrics files beside the songs. This guide is for people who already run Docker Compose and a reverse proxy or Tailscale.

## Requirements

- Docker with Compose v2.
- An HTTPS address that reaches the container's port 8080 (a reverse proxy, Tailscale Serve, or similar). A player served over HTTPS can't call a plain-HTTP server.
- A player to pair with: `https://taiko-player.pages.dev/` (the default `APP_URL`), or your own build of this repo on any static host.

## Library layout

You name the folders to share (the roots). The player browses them folder by folder: the server reads a folder when a device opens it, so there is no scan and nothing to wait for. It lists sub-folders and `flac`, `mp3`, `m4a`, `aac`, `ogg`, `oga`, `opus` and `wav` files in file-name order, and skips dot-files and NAS housekeeping folders (`@eaDir`, `#recycle`). Songs are named by their tags (FLAC and ID3), which the server reads the first time a folder is opened and remembers while the files don't change; a file without tags shows its file name.

What the player uses from a file's tags:

| Tag | Used for |
|---|---|
| `TITLE`, `ARTIST`, `ALBUM`, `TRACKNUMBER`, `DISCNUMBER` | The song's names and its place on the album. |
| `TITLESORT`, `ARTISTSORT`, `ALBUMSORT` | A reading in Latin letters (romaji, for Japanese music), shown beside a name that isn't in Latin script. |
| `TITLE_EN`, `ARTIST_EN`, `ALBUM_EN` | The official English name, shown when it differs. These three names are a convention shared with Ringobushi, not a standard. |
| `APPLE_SONG_ID` | Links the song to Apple Music when it has no lyrics file to carry the id. |

A picture named `cover`, `folder` or `front` (JPEG, PNG or WebP) in a folder is shown as that album's cover. It is served at its own size, since the server has nothing to resize it with, so a very large cover costs every device that opens the folder.

The player's first screen is a library of albums and artists. It is built only from the roots you name in `LIBRARY_SCAN` (`on` for every root, or root names separated by commas; `off` by default), so name the roots whose folders are tagged albums: `Artist/Album/songs`, with `ALBUM`, `ALBUMARTIST` and `DATE` tags and a `cover.jpg`. A folder that directly holds songs is one album. Roots left out are still browsed and played by folder. A `cover.small.jpg` beside `cover.jpg` (about 600 pixels wide) is used for the page of albums, which otherwise loads every cover at full size.

Lyrics are found beside a song, by name: `Song.flac` takes `Song.json`, `Song.ttml`, `Song.lrc`, and versions such as `Song.ja-Latn.json` or `Song_en.json`. The player combines the versions.

The library is mounted read-only. The server writes only its data volume.

## Configure and start

```sh
npm install
npm run server:build        # makes server/dist/server.mjs, which the image copies
cd server/deploy
cp .env.example .env        # then edit .env
docker compose up -d --build
```

`.env.example` documents every setting. The ones you must set:

| Setting | Meaning |
|---|---|
| `PUBLIC_BASE` | The HTTPS address devices reach the server at, ending in `/api/`, e.g. `https://nas.example.com/taiko/api/`. The server and its subcommands refuse to start without it. A proxy serving it under a sub-path must pass the path through unchanged. |
| `LIBRARY_MOUNT` | The host folder that holds your music, bound read-only at `/library`. |
| `LIBRARY_ROOTS` | The folders to share, as `name=folder` pairs inside the container, e.g. `Music=/library`. The names are the top-level folders the player shows. |
| `APP_URL` | The player that pairing links open. It is also the only web origin allowed to call the server. |

## Pair a device

```sh
docker compose exec taiko-server node /app/server.mjs invite
```

This prints a pairing code and a link. Open the link on the device: the player shows which server it is about to pair with, asks for a device name, and pairs. A code works once and lasts three days (`invite --days N` changes that). Without the link, type the server address and the code on the player's first screen.

```sh
docker compose exec taiko-server node /app/server.mjs devices           # who is paired
docker compose exec taiko-server node /app/server.mjs unpair <id|name>  # remove one
```

## Deploy from the repo over ssh

`npm run server:deploy` does the build-and-ship steps for a NAS you reach by ssh. It needs bash (Git Bash on Windows), ssh access to the NAS and Docker with buildx on the machine you run it from.

1. On the NAS, make `~/taiko-server/.env` from `.env.example`. If Caddy fronts the server, `PUBLIC_BASE` must be the Caddy site plus `/taiko/api/`, e.g. `https://nas.example.com/taiko/api/`.
2. If Caddy runs in Docker, attach the server to Caddy's network in `~/taiko-server/compose.override.yaml` on the NAS (the route reaches it as `taiko-server:8080`).
3. In the repo, put the NAS's details in `.env.local` (git ignores it):

   ```
   TAIKO_NAS_HOST=nas
   TAIKO_CADDY_SITE=https://nas.example.com
   ```

4. Run `npm run server:deploy`.

The script checks the NAS's `.env` first and refuses to go on if a required setting is missing or `PUBLIC_BASE` doesn't match the route. Then it bundles the server, builds the image for linux/amd64, ships it over ssh, writes `~/taiko-server/compose.yaml`, starts the service, removes the images earlier deploys left on the NAS, and adds a `/taiko/*` route to the Caddy site (`~/caddy/Caddyfile`, backed up first, validated, reloaded and never restarted). It never writes the NAS's `.env` or `compose.override.yaml`. Leave `TAIKO_CADDY_SITE` unset to skip Caddy.

The compose file publishes the server on the host's port 8080. If that port is taken on the NAS, set `HOST_PORT` in its `.env`.

```sh
npm run server:deploy -- --invite            # a pairing code and link
npm run server:deploy -- --devices           # who is paired
npm run server:deploy -- --unpair <id|name>  # remove one
```

## What to know

- **Audio links.** A browser's audio player can't send the device's token, so the server hands out signed links that work for six hours. An unpaired device's open links keep working until they expire.
- **Pairing attempts are limited** to ten per ten minutes per address. Behind a reverse proxy every device shares that limit, because the server sees only the proxy's address.
- **Local network access.** When the server's address is a private one (a LAN or Tailscale address) and the player is the hosted site, Chrome asks the person to allow local network access the first time. Pairing fails until they allow it.
- **Building the image.** `npm run server:deploy` builds on your machine when Docker is running there, and on the NAS when it isn't. Only the NAS-side build has been used so far.
