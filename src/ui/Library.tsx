import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Track } from '../library/tracks';
import type { QueueSource, SavedTrack } from '../player/persist';
import type { Snapshot } from '../player/store';
import { sharedKey, store } from '../player/store';
import type { NasAlbum } from '../shared/api';
import { otherForms, qualityOf } from './format';
import { AddToPlaylist, ForgetSongs, HEART, HEART_ON, playlistsKept, LIST, NOTE, RowMenu, SongRow, hasLyrics, rowText } from './rows';

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

/** How the album's audio is stored, when every song is stored the same way. */
function sharedQuality(tracks: Track[]): string {
  const first = tracks.length ? qualityOf(tracks[0]) : '';
  return first && tracks.every((track) => qualityOf(track) === first) ? first : '';
}

/** A favourite or a played album as a tile: the library's cover and names when it is in the library, else what was noted. */
function NotedAlbums({ snap, albums, className }: { snap: Snapshot; albums: { path: string; title: string; artist: string }[]; className?: string }) {
  return (
    <ul className={className ?? 'tiles'}>
      {albums.map((album) => {
        const known = snap.library.albums.find((candidate) => candidate.path === album.path);
        return (
          <Tile
            key={album.path}
            cover={known?.cover}
            title={known?.title ?? (album.title || album.path.split('/').pop() || '')}
            detail={known ? artistOf(known) : album.artist}
            onOpen={() => void store.showAlbum(album.path)}
          />
        );
      })}
    </ul>
  );
}

/** The albums the listener played lately, in a row above the library. */
function RecentlyPlayed({ snap }: { snap: Snapshot }) {
  const albums = snap.history?.albums ?? [];
  if (!albums.length) return null;
  return (
    <section className="recent" aria-label="Recently played">
      <h2>Recently played</h2>
      <NotedAlbums snap={snap} albums={albums} className="tiles strip" />
    </section>
  );
}

/** A list of songs the NAS keeps for the listener (favourites, history), which play as a queue. */
function SavedSongs({ snap, songs, source, meta, numbered = false }: { snap: Snapshot; songs: SavedTrack[]; source: QueueSource; meta?: (index: number) => string; numbered?: boolean }) {
  return (
    <ul className="songlist">
      {songs.map((song, index) => {
        const text = rowText(song);
        return (
          <SongRow
            key={`${song.id}:${index}`}
            text={{ ...text, lead: numbered ? index + 1 : text.lead, meta: [meta?.(index) ?? '', text.meta].filter(Boolean).join(', ') }}
            current={`nas:${song.id}` === snap.currentId}
            onPlay={() => void store.playSaved(songs, source, index)}
          />
        );
      })}
    </ul>
  );
}

/** The listener's favourites: albums, then songs, newest first. */
function Favourites({ snap }: { snap: Snapshot }) {
  const favourites = snap.favourites;
  if (!favourites) return null;
  if (!favourites.albums.length && !favourites.songs.length) {
    return <p className="library-note">No favourites yet. Mark a song with the heart beside it while it plays, or an album from its page. They are yours alone, on every device you add.</p>;
  }
  const songs = [...favourites.songs].reverse().map((song) => song.track);
  return (
    <>
      {favourites.albums.length > 0 && (
        <section className="noted">
          <h2>Albums</h2>
          <NotedAlbums snap={snap} albums={[...favourites.albums].reverse()} />
        </section>
      )}
      {songs.length > 0 && (
        <section className="noted">
          <h2>Songs</h2>
          <div className="actions"><button className="plain-button primary-button" type="button" onClick={() => void store.playSaved(songs, { kind: 'favourites' }, 0)}>Play</button></div>
          <SavedSongs snap={snap} songs={songs} source={{ kind: 'favourites' }} />
        </section>
      )}
    </>
  );
}

/** When something was played, said the way a person would: the time today, the day this week, the date before that. */
function whenPlayed(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days <= 0) return time;
  if (days === 1) return `yesterday, ${time}`;
  if (days < 7) return at.toLocaleDateString([], { weekday: 'long' });
  return at.toLocaleDateString([], { day: 'numeric', month: 'short', ...(days > 300 ? { year: 'numeric' } : {}) });
}

/** The listener's history: what they play most, and what they played lately. */
function History({ snap }: { snap: Snapshot }) {
  const history = snap.history;
  if (!history) return <p className="library-note">Reading your history</p>;
  if (!history.total) {
    return <p className="library-note">Nothing played yet. A song joins your history once you have heard half of it, or four minutes. Your history is yours alone.</p>;
  }
  return (
    <>
      <section className="noted">
        <h2>Most played</h2>
        <SavedSongs snap={snap} songs={history.top.map((entry) => entry.track)} source={{ kind: 'history' }} numbered meta={(index) => count(history.top[index].count, 'play')} />
      </section>
      <section className="noted">
        <h2>Played lately</h2>
        <SavedSongs snap={snap} songs={history.plays.map((play) => play.track)} source={{ kind: 'history' }} meta={(index) => whenPlayed(history.plays[index].at)} />
        <p className="library-foot">{count(history.total, 'play')} in all{history.total > history.plays.length ? `; the latest ${history.plays.length} are listed` : ''}.</p>
      </section>
    </>
  );
}

/** The albums added most lately, in a row to scroll along, above a library big enough to lose them in. */
function RecentlyAdded({ albums }: { albums: NasAlbum[] }) {
  if (albums.length <= RECENT_SHOWN) return null;
  const recent = [...albums].sort((a, b) => b.addedAt - a.addedAt).slice(0, RECENT_SHOWN);
  return (
    <section className="recent" aria-label="Recently added">
      <h2>Recently added</h2>
      <AlbumTiles albums={recent} className="tiles strip" />
    </section>
  );
}
const RECENT_SHOWN = 10;

function AlbumTiles({ albums, withArtist = true, className = 'tiles' }: { albums: NasAlbum[]; withArtist?: boolean; className?: string }) {
  return (
    <ul className={className}>
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
  const loved = snap.favourites?.albums.some((album) => album.path === path) ?? false;

  return (
    <>
      <Crumbs steps={[{ name: 'Library', open: () => store.showHome() }, ...(artist ? [{ name: artist, open: () => store.showArtist(artist) }] : []), { name: title }]} />
      <Sleeve
        cover={view?.cover ?? known?.cover}
        title={title}
        other={known && otherForms(known.title, known.titleRoman, known.titleEnglish)}
        artist={artist && <button className="text-button" type="button" onClick={() => store.showArtist(artist)}>{artist}</button>}
        facts={[yearOf(known?.date ?? tracks[0]?.date ?? ''), tracks.length ? count(tracks.length, 'song') : '', lengthOf(seconds), sharedQuality(tracks)]}
      >
        <button className="plain-button primary-button" type="button" disabled={!tracks.length} onClick={() => play()}>Play</button>
        {snap.favourites && tracks.length > 0 && (
          <button className="plain-button with-icon" type="button" aria-pressed={loved} onClick={() => void store.toggleFavouriteAlbum({ path, title, artist })}>
            {loved ? HEART_ON : HEART}{loved ? 'In your favourites' : 'Add to favourites'}
          </button>
        )}
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
          const plays = track.nas ? snap.playCounts[track.nas.id] ?? 0 : 0;
          const meta = [plays ? count(plays, 'play') : '', text.meta].filter(Boolean).join(', ');
          return (
            <SongRow
              key={track.id}
              text={{ ...text, detail, lead, meta }}
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
      <Sleeve cover={tracks[0]?.cover} title={name} artist={artist} facts={[count(tracks.length, 'song'), 'on this device', sharedQuality(tracks)]}>
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

type Shelf = 'albums' | 'artists' | 'playlists' | 'favourites' | 'history';
const SHELF_KEY = 'taiko:library-shelf';

function loadShelf(): Shelf {
  try {
    const saved = localStorage.getItem(SHELF_KEY);
    return saved === 'artists' || saved === 'playlists' || saved === 'favourites' || saved === 'history' ? saved : 'albums';
  } catch {
    return 'albums';
  }
}

function Home({ snap }: { snap: Snapshot }) {
  const [shelf, setShelf] = useState(loadShelf);
  const [sort, setSort] = useState(loadSort);
  const { library } = snap;
  const artists = artistsOf(library.albums);
  const device = deviceAlbums(snap.tracks);
  const shelves: [Shelf, string][] = snap.pairing
    ? [['albums', 'Albums'], ['artists', 'Artists'], ['playlists', 'Playlists'], ...(snap.favourites ? [['favourites', 'Favourites'], ['history', 'History']] as [Shelf, string][] : [])]
    : [];
  // A shelf remembered from a NAS that kept favourites isn't one this NAS has.
  const shown: Shelf = shelves.some(([name]) => name === shelf) ? shelf : 'albums';
  const reading = library.state === 'loading' || library.state === 'idle' || library.scanning;

  const chooseShelf = (value: Shelf) => {
    setShelf(value);
    try {
      localStorage.setItem(SHELF_KEY, value);
    } catch {
      // The choice lasts for this visit.
    }
  };
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
                <button key={name} type="button" role="tab" aria-selected={name === shown} className={name === shown ? 'tab current' : 'tab'} onClick={() => chooseShelf(name)}>{label}</button>
              ))}
            </div>
            {shown === 'albums' && library.albums.length > 1 && (
              <select className="library-sort" value={sort} aria-label="Order of the albums" onChange={(e) => chooseSort(e.currentTarget.value as Sort)}>
                {Object.entries(SORTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            )}
          </header>

          {shown !== 'playlists' && library.state === 'off' && (
            <p className="library-note">
              {snap.pairing.serverName} keeps no album library, so its music is listed by folder. <button className="text-button" type="button" onClick={() => store.openSongs('folders')}>Open its folders</button>
            </p>
          )}
          {shown !== 'playlists' && library.state === 'error' && (
            <p className="library-note">The library didn't load. <button className="text-button" type="button" onClick={() => void store.loadLibrary()}>Try again</button></p>
          )}
          {shown !== 'playlists' && library.state === 'ready' && library.albums.length === 0 && !library.scanning && (
            <p className="library-note">The NAS has found no albums yet. Albums are folders of tagged songs in the music it was set to read.</p>
          )}

          {shown === 'albums' && <RecentlyPlayed snap={snap} />}
          {shown === 'albums' && sort !== 'added' && <RecentlyAdded albums={library.albums} />}
          {shown === 'albums' && <AlbumTiles albums={sorted(library.albums, sort)} />}
          {shown === 'artists' && <ArtistList artists={artists} />}
          {shown === 'favourites' && <Favourites snap={snap} />}
          {shown === 'history' && <History snap={snap} />}
          {shown === 'playlists' && (
            <>
              {snap.playlists.length === 0 && snap.sharedPlaylists.length === 0 && <p className="library-note">No playlists yet. Add a song or an album to a new one from the button at the end of its row. {playlistsKept(snap)}</p>}
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
                {snap.sharedPlaylists.map((playlist) => (
                  <li key={sharedKey(playlist)}>
                    <button type="button" className="name-row with-lead" onClick={() => { store.showShared(sharedKey(playlist)); store.openSongs('playlists'); }}>
                      <span className="name-row-lead">{LIST}</span>
                      <span className="name-row-title">{playlist.name}</span>
                      <span className="name-row-detail">{playlist.owner.name}'s, {count(playlist.tracks.length, 'song')}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {snap.playlists.length > 0 && <p className="library-foot">{playlistsKept(snap)}</p>}
            </>
          )}

          {shown !== 'playlists' && library.state !== 'off' && (
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
          <div className="library-foot">
            <p>These songs are copies kept in this browser. They were never uploaded.</p>
            <ForgetSongs />
          </div>
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
