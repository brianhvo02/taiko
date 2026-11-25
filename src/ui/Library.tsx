import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Track } from '../library/tracks';
import type { Snapshot } from '../player/store';
import { store } from '../player/store';
import type { NasAlbum } from '../shared/api';
import { otherForms } from './format';
import { AddToPlaylist, LIST, NOTE, RowMenu, SongRow, hasLyrics, rowText } from './rows';

/**
 * The library: the albums the NAS has read from its tagged music, their artists, the playlists, and the songs
 * picked on this device grouped by their album tag.
 */

/** What an album with no artist of its own (a compilation) is filed under. */
export const VARIOUS = 'Various artists';
/** What this device's songs without an album tag are grouped as. */
const LOOSE = 'Other songs';

const artistOf = (album: NasAlbum) => album.artist || VARIOUS;
const yearOf = (date: string) => /^\d{4}/.exec(date)?.[0] ?? '';
const fold = (text: string) => text.normalize('NFKC').toLowerCase();
const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** Whether every word of what was typed is somewhere in the names given. */
function matches(query: string, ...names: (string | undefined)[]): boolean {
  const hay = fold(names.filter(Boolean).join('\n'));
  return fold(query).split(/\s+/).filter(Boolean).every((word) => hay.includes(word));
}

/** An album's whole length in words, as a sleeve would give it. */
function lengthOf(seconds: number | null): string {
  if (!seconds) return '';
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

type Sort = 'artist' | 'added' | 'title' | 'year';
const SORTS: Record<Sort, string> = { artist: 'By artist', added: 'Newest first', title: 'By title', year: 'By year' };
const SORT_KEY = 'taiko:library-sort';

function loadSort(): Sort {
  try {
    const saved = localStorage.getItem(SORT_KEY);
    return saved && saved in SORTS ? (saved as Sort) : 'artist';
  } catch {
    return 'artist';
  }
}

function sorted(albums: NasAlbum[], sort: Sort): NasAlbum[] {
  // The NAS sends them by artist, then date, then title.
  if (sort === 'artist') return albums;
  const byName = (a: NasAlbum, b: NasAlbum) => (a.titleRoman ?? a.title).localeCompare(b.titleRoman ?? b.title);
  const order: Record<Exclude<Sort, 'artist'>, (a: NasAlbum, b: NasAlbum) => number> = {
    added: (a, b) => b.addedAt - a.addedAt,
    title: byName,
    year: (a, b) => b.date.localeCompare(a.date) || byName(a, b),
  };
  return [...albums].sort(order[sort]);
}

interface Artist {
  name: string;
  reading: string;
  albums: NasAlbum[];
}

function artistsOf(albums: NasAlbum[]): Artist[] {
  const found = new Map<string, Artist>();
  for (const album of albums) {
    const name = artistOf(album);
    const artist = found.get(name) ?? { name, reading: otherForms(name, album.artistRoman, album.artistEnglish), albums: [] };
    artist.albums.push(album);
    found.set(name, artist);
  }
  const key = (artist: Artist) => artist.albums[0].artistRoman ?? artist.name;
  return [...found.values()].sort((a, b) => Number(a.name === VARIOUS) - Number(b.name === VARIOUS) || key(a).localeCompare(key(b)));
}

/** This device's songs, grouped by their album tag in the order they were added. */
function deviceAlbums(tracks: Track[]): { name: string; tracks: Track[] }[] {
  const found = new Map<string, Track[]>();
  for (const track of tracks) found.set(track.album || LOOSE, [...(found.get(track.album || LOOSE) ?? []), track]);
  return [...found].map(([name, list]) => ({ name, tracks: list }));
}

function Cover({ src, name }: { src: string | null | undefined; name: string }) {
  return src
    ? <img className="cover" src={src} alt="" loading="lazy" decoding="async" />
    : <span className="cover blank" aria-hidden="true" lang="ja">{[...name.trim()][0] ?? '太'}</span>;
}

function Tile({ cover, title, detail, onOpen }: { cover: string | null | undefined; title: string; detail: string; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="tile" onClick={onOpen}>
        <Cover src={cover} name={title} />
        <span className="tile-title">{title}</span>
        <span className="tile-detail">{detail}</span>
      </button>
    </li>
  );
}

function AlbumTiles({ albums, withArtist = true }: { albums: NasAlbum[]; withArtist?: boolean }) {
  return (
    <ul className="tiles">
      {albums.map((album) => (
        <Tile
          key={album.path}
          cover={album.cover}
          title={album.title}
          detail={[withArtist ? artistOf(album) : '', yearOf(album.date)].filter(Boolean).join(', ')}
          onOpen={() => void store.showAlbum(album.path)}
        />
      ))}
    </ul>
  );
}

function ArtistList({ artists }: { artists: Artist[] }) {
  return (
    <ul className="names">
      {artists.map((artist) => (
        <li key={artist.name}>
          <button type="button" className="name-row" onClick={() => store.showArtist(artist.name)}>
            <span className="name-row-title">{artist.name}</span>
            <span className="name-row-detail">{[artist.reading, count(artist.albums.length, 'album')].filter(Boolean).join(', ')}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Crumbs({ steps }: { steps: { name: string; open?: () => void }[] }) {
  return (
    <nav className="crumbs" aria-label="Where this is in the library">
      {steps.map((step, i) => (
        <span key={i}>
          {i > 0 && <span aria-hidden="true"> / </span>}
          {step.open ? <button className="text-button" type="button" onClick={step.open}>{step.name}</button> : step.name}
        </span>
      ))}
    </nav>
  );
}

/** An album's sleeve: its cover, what it is called, and what can be done with it. */
function Sleeve({ cover, title, other, artist, facts, children }: { cover: string | null | undefined; title: string; other?: string; artist?: ReactNode; facts: string[]; children: ReactNode }) {
  return (
    <header className="sleeve">
      <Cover src={cover} name={title} />
      <div className="sleeve-text">
        <h1>{title}</h1>
        {other && <p className="sleeve-other">{other}</p>}
        {artist && <p className="sleeve-artist">{artist}</p>}
        <p className="sleeve-facts">{facts.filter(Boolean).join(', ')}</p>
        <div className="actions">{children}</div>
      </div>
    </header>
  );
}

function AlbumPage({ snap, path }: { snap: Snapshot; path: string }) {
  const view = snap.album?.path === path ? snap.album : null;
  const known = snap.library.albums.find((album) => album.path === path);
  const tracks = view?.tracks ?? [];
  const title = known?.title ?? tracks[0]?.album ?? path.split('/').pop() ?? '';
  const artist = known ? artistOf(known) : tracks[0]?.albumArtist ?? tracks[0]?.artist ?? '';
  const seconds = known?.durationSeconds ?? null;
  const play = (id?: string) => void store.playFrom(tracks, { kind: 'folder', path }, id);
  const discs = new Set(tracks.map((track) => track.discNumber ?? 1)).size > 1;

  return (
    <>
      <Crumbs steps={[{ name: 'Library', open: () => store.showHome() }, ...(artist ? [{ name: artist, open: () => store.showArtist(artist) }] : []), { name: title }]} />
      <Sleeve
        cover={view?.cover ?? known?.cover}
        title={title}
        other={known && otherForms(known.title, known.titleRoman, known.titleEnglish)}
        artist={artist && <button className="text-button" type="button" onClick={() => store.showArtist(artist)}>{artist}</button>}
        facts={[yearOf(known?.date ?? tracks[0]?.date ?? ''), tracks.length ? count(tracks.length, 'song') : '', lengthOf(seconds)]}
      >
        <button className="plain-button primary-button" type="button" disabled={!tracks.length} onClick={() => play()}>Play</button>
        {tracks.length > 0 && <RowMenu label="More for this album">{(close) => <AddToPlaylist snap={snap} tracks={tracks} close={close} />}</RowMenu>}
      </Sleeve>
      {(!view || view.state === 'loading') && <p className="library-note">Opening the album</p>}
      {view?.state === 'missing' && <p className="library-note">The NAS doesn't have this album any more. <button className="text-button" type="button" onClick={() => store.showHome()}>Back to the library</button></p>}
      <ul className="songlist">
        {tracks.map((track) => {
          const text = rowText(track, hasLyrics(track));
          // On its own album a song needs no album name; its artist only when it isn't the album's.
          const detail = otherForms(track.title, track.titleRoman, track.titleEnglish) || (track.artist !== artist ? track.artist : '');
          const lead = discs && track.trackNumber ? `${track.discNumber ?? 1}-${track.trackNumber}` : text.lead;
          return (
            <SongRow
              key={track.id}
              text={{ ...text, detail, lead }}
              current={track.id === snap.currentId}
              onPlay={() => play(track.id)}
              menu={<RowMenu label={`More for ${track.title}`}>{(close) => <AddToPlaylist snap={snap} tracks={[track]} close={close} />}</RowMenu>}
            />
          );
        })}
      </ul>
    </>
  );
}

function DeviceAlbumPage({ snap, name }: { snap: Snapshot; name: string }) {
  const tracks = snap.tracks.filter((track) => (track.album || LOOSE) === name);
  const artists = new Set(tracks.map((track) => track.albumArtist ?? track.artist));
  const artist = artists.size === 1 ? [...artists][0] : '';
  return (
    <>
      <Crumbs steps={[{ name: 'Library', open: () => store.showHome() }, { name: 'This device' }, { name }]} />
      <Sleeve cover={tracks[0]?.cover} title={name} artist={artist} facts={[count(tracks.length, 'song'), 'on this device']}>
        <button className="plain-button primary-button" type="button" disabled={!tracks.length} onClick={() => void store.playFrom(tracks, { kind: 'device' })}>Play</button>
      </Sleeve>
      <ul className="songlist">
        {tracks.map((track) => (
          <SongRow
            key={track.id}
            text={{ ...rowText(track, hasLyrics(track)), detail: otherForms(track.title, track.titleRoman, track.titleEnglish) || (track.artist !== artist ? track.artist : '') }}
            current={track.id === snap.currentId}
            onPlay={() => void store.playFrom(tracks, { kind: 'device' }, track.id)}
          />
        ))}
      </ul>
    </>
  );
}

function ArtistPage({ snap, name }: { snap: Snapshot; name: string }) {
  const albums = snap.library.albums.filter((album) => artistOf(album) === name);
  const reading = albums[0] ? otherForms(name, albums[0].artistRoman, albums[0].artistEnglish) : '';
  const byDate = [...albums].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <Crumbs steps={[{ name: 'Library', open: () => store.showHome() }, { name }]} />
      <header className="library-head">
        <h1>{name}</h1>
        {reading && <p className="sleeve-other">{reading}</p>}
      </header>
      {albums.length === 0 && (
        <p className="library-note">
          {snap.library.state === 'loading' || snap.library.state === 'idle' ? 'Reading the library' : 'The library has no albums by this artist.'}
        </p>
      )}
      <AlbumTiles albums={byDate} withArtist={false} />
    </>
  );
}

/** What the library holds that matches the search: albums and artists found here, songs found by the NAS. */
function Results({ snap, query }: { snap: Snapshot; query: string }) {
  const albums = snap.library.albums.filter((album) => matches(query, album.title, album.titleRoman, album.titleEnglish, album.artist, album.artistRoman, album.artistEnglish));
  const artists = artistsOf(snap.library.albums).filter((artist) => matches(query, artist.name, artist.reading));
  const device = snap.tracks.filter((track) => matches(query, track.title, track.titleRoman, track.titleEnglish, track.artist, track.album));
  const songs = [...device, ...snap.searchTracks];
  const nothing = albums.length + artists.length + songs.length === 0;
  return (
    <>
      <header className="library-head"><h1>Results for "{query}"</h1></header>
      {nothing && <p className="library-note">Nothing in your library matches. Search looks at song, album and artist names, in any of their spellings.</p>}
      {artists.length > 0 && <section><h2>Artists</h2><ArtistList artists={artists} /></section>}
      {albums.length > 0 && <section><h2>Albums</h2><AlbumTiles albums={albums} /></section>}
      {songs.length > 0 && (
        <section>
          <h2>Songs</h2>
          <ul className="songlist">
            {songs.map((track) => (
              <SongRow
                key={track.id}
                text={{ ...rowText(track, hasLyrics(track)), lead: NOTE, detail: [track.artist, track.album].filter(Boolean).join(', ') }}
                current={track.id === snap.currentId}
                onPlay={() => void store.playFrom(track.nas ? snap.searchTracks : device, track.nas ? { kind: 'search', query } : { kind: 'device' }, track.id)}
                menu={track.nas && <RowMenu label={`More for ${track.title}`}>{(close) => <AddToPlaylist snap={snap} tracks={[track]} close={close} />}</RowMenu>}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

type Shelf = 'albums' | 'artists' | 'playlists';

function Home({ snap }: { snap: Snapshot }) {
  const [shelf, setShelf] = useState<Shelf>('albums');
  const [sort, setSort] = useState(loadSort);
  const { library } = snap;
  const artists = artistsOf(library.albums);
  const device = deviceAlbums(snap.tracks);
  const shelves: [Shelf, string][] = snap.pairing ? [['albums', 'Albums'], ['artists', 'Artists'], ['playlists', 'Playlists']] : [];
  const reading = library.state === 'loading' || library.state === 'idle' || library.scanning;

  const chooseSort = (value: Sort) => {
    setSort(value);
    try {
      localStorage.setItem(SORT_KEY, value);
    } catch {
      // The choice lasts for this visit.
    }
  };

  return (
    <>
      {snap.pairing && (
        <section className="shelf">
          <header className="library-head">
            <h1>Library</h1>
            <div className="tabs" role="tablist" aria-label="What to list">
              {shelves.map(([name, label]) => (
                <button key={name} type="button" role="tab" aria-selected={name === shelf} className={name === shelf ? 'tab current' : 'tab'} onClick={() => setShelf(name)}>{label}</button>
              ))}
            </div>
            {shelf === 'albums' && library.albums.length > 1 && (
              <select className="library-sort" value={sort} aria-label="Order of the albums" onChange={(e) => chooseSort(e.currentTarget.value as Sort)}>
                {Object.entries(SORTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            )}
          </header>

          {shelf !== 'playlists' && library.state === 'off' && (
            <p className="library-note">
              {snap.pairing.serverName} keeps no album library, so its music is listed by folder. <button className="text-button" type="button" onClick={() => store.openSongs('folders')}>Open its folders</button>
            </p>
          )}
          {shelf !== 'playlists' && library.state === 'error' && (
            <p className="library-note">The library didn't load. <button className="text-button" type="button" onClick={() => void store.loadLibrary()}>Try again</button></p>
          )}
          {shelf !== 'playlists' && library.state === 'ready' && library.albums.length === 0 && !library.scanning && (
            <p className="library-note">The NAS has found no albums yet. Albums are folders of tagged songs in the music it was set to read.</p>
          )}

          {shelf === 'albums' && <AlbumTiles albums={sorted(library.albums, sort)} />}
          {shelf === 'artists' && <ArtistList artists={artists} />}
          {shelf === 'playlists' && (
            <>
              {snap.playlists.length === 0 && <p className="library-note">No playlists yet. Add a song or an album to a new one from the button at the end of its row. Playlists are kept in this browser.</p>}
              <ul className="names">
                {snap.playlists.map((playlist) => (
                  <li key={playlist.id}>
                    <button type="button" className="name-row with-lead" onClick={() => { store.showPlaylist(playlist.id); store.openSongs('playlists'); }}>
                      <span className="name-row-lead">{LIST}</span>
                      <span className="name-row-title">{playlist.name}</span>
                      <span className="name-row-detail">{count(playlist.tracks.length, 'song')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {shelf !== 'playlists' && library.state !== 'off' && (
            <p className="library-foot">
              {reading ? `Reading the music on ${snap.pairing.serverName}` : (
                <>
                  {count(library.albums.length, 'album')} by {count(artists.length, 'artist')} on {snap.pairing.serverName}. <button className="text-button" type="button" onClick={() => void store.rescanLibrary()}>Look for new music</button>
                </>
              )}
            </p>
          )}
        </section>
      )}

      {device.length > 0 && (
        <section className="shelf">
          <header className="library-head">{snap.pairing ? <h2>On this device</h2> : <h1>On this device</h1>}</header>
          <ul className="tiles">
            {device.map((album) => (
              <Tile key={album.name} cover={album.tracks[0].cover} title={album.name} detail={count(album.tracks.length, 'song')} onOpen={() => store.showDeviceAlbum(album.name)} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export function Library({ snap }: { snap: Snapshot }) {
  const query = snap.libraryQuery.trim();
  const { page } = snap;
  return (
    <div className="library">
      {query ? <Results snap={snap} query={query} />
        : page.kind === 'album' ? <AlbumPage snap={snap} path={page.path} />
          : page.kind === 'artist' ? <ArtistPage snap={snap} name={page.name} />
            : page.kind === 'deviceAlbum' ? <DeviceAlbumPage snap={snap} name={page.name} />
              : <Home snap={snap} />}
    </div>
  );
}
