import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { LiveDevice } from '../shared/api';
import { smallCover } from '../library/tracks';
import type { Snapshot, SongsTab } from '../player/store';
import { playlistKey, sharedKey, store } from '../player/store';
import { transitionKey } from '../shared/playlists';
import type { PlaylistAccess, Transition } from '../shared/playlists';
import { TransitionDialog } from './TransitionDialog';
import { canPickFolder, formatTime, pickFiles } from './format';
import { ACCESS, AddToPlaylist, FOLDER, ForgetSongs, KeepButton, NOTE, QueueItems, playlistsKept, LIST, RowMenu, SongRow, hasLyrics, rowText } from './rows';

/** The paired NAS, folder by folder. A folder of songs plays through as an album. */
function Folders({ snap, wanted, onChosen }: { snap: Snapshot; wanted: string; onChosen: () => void }) {
  const folder = snap.nasFolder;
  const segments = folder?.path ? folder.path.split('/') : [];
  const matches = (name: string) => !wanted || name.toLowerCase().includes(wanted);
  const folders = folder?.folders.filter((entry) => matches(entry.name)) ?? [];
  const tracks = folder?.tracks.filter((track) => matches(track.title)) ?? [];
  const empty = folder && folders.length === 0 && tracks.length === 0;
  const all = folder?.tracks ?? [];
  const play = (id?: string) => { void store.playFrom(all, { kind: 'folder', path: folder?.path ?? '' }, id); onChosen(); };

  return (
    <>
      <nav className="crumbs" aria-label="Folder">
        <button className="text-button" type="button" onClick={() => void store.browse('')} disabled={segments.length === 0}>All folders</button>
        {segments.map((name, i) => (
          <span key={i}>
            <span aria-hidden="true"> / </span>
            <button className="text-button" type="button" onClick={() => void store.browse(segments.slice(0, i + 1).join('/'))} disabled={i === segments.length - 1}>{name}</button>
          </span>
        ))}
      </nav>
      {folder && all.length > 0 && (
        <div className={folder.cover ? 'album' : 'album no-cover'}>
          {folder.cover && <img className="folder-cover" src={smallCover(folder.cover)} alt="" />}
          <div className="album-text">
            <div className="album-name">{segments[segments.length - 1]}</div>
            <div className="actions">
              <button className="plain-button primary-button" type="button" onClick={() => play()}>Play</button>
              <RowMenu label="More for this folder">{(close) => <AddToPlaylist snap={snap} tracks={all} close={close} />}</RowMenu>
            </div>
          </div>
        </div>
      )}
      {snap.nasState === 'loading' && !folder && <p className="songs-note">Opening the NAS</p>}
      {snap.nasState === 'error' && <p className="songs-note">The folder didn't open. <button className="text-button" type="button" onClick={() => void store.refreshNas()}>Try again</button></p>}
      {empty && <p className="songs-note">{wanted ? 'Nothing here matches the filter.' : 'This folder has no songs or folders.'}</p>}
      <ul className={snap.nasState === 'loading' ? 'busy' : undefined}>
        {folders.map((entry) => (
          <li className="song-row" key={entry.path}>
            <button type="button" className="song folder" onClick={() => void store.browse(entry.path)}>
              <span className="song-lead">{FOLDER}<span className="sr-only">Folder</span></span>
              <span className="song-title">{entry.name}</span>
            </button>
          </li>
        ))}
        {tracks.map((track) => (
          <SongRow
            key={track.id}
            text={rowText(track, hasLyrics(track))}
            current={track.id === snap.currentId}
            onPlay={() => play(track.id)}
            menu={<RowMenu label={`More for ${track.title}`}>{(close) => <AddToPlaylist snap={snap} tracks={[track]} close={close} />}</RowMenu>}
          />
        ))}
      </ul>
    </>
  );
}

/** Someone else's playlist: to play, and to change when its owner lets everyone. */
function SharedView({ snap, at, wanted, onChosen }: { snap: Snapshot; at: string; wanted: string; onChosen: () => void }) {
  const playlist = snap.sharedPlaylists.find((candidate) => sharedKey(candidate) === at);
  if (!playlist) return null;
  const count = playlist.tracks.length;
  const open = playlist.access === 'collaborative';
  return (
    <>
      <nav className="crumbs" aria-label="Playlist">
        <button className="text-button" type="button" onClick={() => store.showShared(null)}>All playlists</button>
        <span aria-hidden="true"> / </span>{playlist.name}
      </nav>
      <div className="album no-cover">
        <div className="album-text">
          <div className="album-name">{playlist.name}</div>
          <p className="whose">{playlist.owner.name}'s playlist. {open ? 'You can add songs to it, reorder them and remove them.' : 'You can play it; only they can change it.'}</p>
          <div className="actions">
            <button className="plain-button primary-button" type="button" disabled={!count} onClick={() => { void store.playShared(at); onChosen(); }}>Play</button>
          </div>
        </div>
      </div>
      {count === 0 && <p className="songs-note">This playlist is empty.{open ? " Add songs to it from their folders, with the button at the end of a song's row." : ''}</p>}
      <ul>
        {playlist.tracks.map((song, index) => (!wanted || song.title.toLowerCase().includes(wanted)) && (
          <SongRow
            key={song.id}
            text={{ ...rowText(song), lead: index + 1 }}
            current={`nas:${song.id}` === snap.currentId}
            onPlay={() => { void store.playShared(at, index); onChosen(); }}
            menu={(
              <RowMenu label={`More for ${song.title}`}>{(close) => (
                <>
                  <QueueItems song={song} close={close} />
                  {open && (
                    <>
                      <button type="button" className="menu-item" disabled={index === 0} onClick={() => { store.moveInShared(at, index, -1); close(); }}>Move up</button>
                      <button type="button" className="menu-item" disabled={index === count - 1} onClick={() => { store.moveInShared(at, index, 1); close(); }}>Move down</button>
                      <button type="button" className="menu-item" onClick={() => { store.removeFromShared(at, index); close(); }}>Remove from playlist</button>
                    </>
                  )}
                </>
              )}</RowMenu>
            )}
          />
        ))}
      </ul>
    </>
  );
}

/** A shaped join, said in a few words on the row of the song it follows. */
function joinSaid(transition: Transition | undefined): string {
  if (!transition) return '';
  return transition.kind === 'fade' ? `fades ${transition.seconds} s` : transition.leave || transition.startAt ? 'cuts' : 'no fade';
}

/** One playlist: its songs in order, to play, reorder and remove, and the playlist itself to rename or delete. */
function PlaylistView({ snap, id, wanted, onChosen }: { snap: Snapshot; id: string; wanted: string; onChosen: () => void }) {
  const playlist = snap.playlists.find((candidate) => candidate.id === id);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // The song whose join with the one after it is being shaped.
  const [shaping, setShaping] = useState<number | null>(null);
  if (!playlist) return null;
  const count = playlist.tracks.length;

  return (
    <>
      <nav className="crumbs" aria-label="Playlist">
        <button className="text-button" type="button" onClick={() => store.showPlaylist(null)}>All playlists</button>
        <span aria-hidden="true"> / </span>{playlist.name}
      </nav>
      <div className="album no-cover">
        <div className="album-text">
          {renaming === null ? <div className="album-name">{playlist.name}</div> : (
            <form className="menu-form" onSubmit={(e) => { e.preventDefault(); store.renamePlaylist(id, renaming); setRenaming(null); }}>
              <input type="text" value={renaming} onChange={(e) => setRenaming(e.currentTarget.value)} aria-label="Playlist name" maxLength={80} autoFocus />
              <button className="plain-button" type="submit">Save</button>
            </form>
          )}
          {deleting ? (
            <div className="actions" role="alert">
              <span>Delete this playlist? Its songs stay on the NAS.</span>
              <button className="plain-button" type="button" onClick={() => store.deletePlaylist(id)}>Delete playlist</button>
              <button className="plain-button" type="button" onClick={() => setDeleting(false)}>Keep it</button>
            </div>
          ) : (
            <div className="actions">
              <button className="plain-button primary-button" type="button" disabled={!count} onClick={() => { void store.playPlaylist(id); onChosen(); }}>Play</button>
              <button className="plain-button" type="button" onClick={() => setRenaming(playlist.name)}>Rename</button>
              <button className="plain-button" type="button" onClick={() => setDeleting(true)}>Delete</button>
              <KeepButton snap={snap} at={playlistKey(id)} total={count} keep={() => void store.keepPlaylistOffline(id)} />
            </div>
          )}
          {snap.user && snap.playlistsShared && (
            <label className="access">
              Who can use it
              <select value={playlist.access ?? 'private'} onChange={(e) => store.setPlaylistAccess(id, e.currentTarget.value as PlaylistAccess)}>
                {(Object.keys(ACCESS) as PlaylistAccess[]).map((access) => <option key={access} value={access}>{ACCESS[access].choice}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>
      {count === 0 && <p className="songs-note">This playlist is empty. Add songs to it from their folders, with the button at the end of a song's row.</p>}
      <ul>
        {playlist.tracks.map((song, index) => (!wanted || song.title.toLowerCase().includes(wanted)) && (
          <SongRow
            key={song.id}
            text={{ ...rowText(song), lead: index + 1, meta: [joinSaid(playlist.transitions?.[transitionKey(song.id, playlist.tracks[index + 1]?.id ?? '')]), rowText(song).meta].filter(Boolean).join(', ') }}
            current={`nas:${song.id}` === snap.currentId}
            onPlay={() => { void store.playPlaylist(id, index); onChosen(); }}
            menu={(
              <RowMenu label={`More for ${song.title}`}>{(close) => (
                <>
                  <QueueItems song={song} close={close} />
                  {index < count - 1 && <button type="button" className="menu-item" onClick={() => { setShaping(index); close(); }}>Shape how it leads into the next song</button>}
                  <button type="button" className="menu-item" disabled={index === 0} onClick={() => { store.moveInPlaylist(id, index, -1); close(); }}>Move up</button>
                  <button type="button" className="menu-item" disabled={index === count - 1} onClick={() => { store.moveInPlaylist(id, index, 1); close(); }}>Move down</button>
                  <button type="button" className="menu-item" onClick={() => { store.removeFromPlaylist(id, index); close(); }}>Remove from playlist</button>
                </>
              )}</RowMenu>
            )}
          />
        ))}
      </ul>
      {shaping !== null && playlist.tracks[shaping] && playlist.tracks[shaping + 1] && (
        <TransitionDialog snap={snap} id={id} from={playlist.tracks[shaping]} to={playlist.tracks[shaping + 1]} index={shaping} onClose={() => setShaping(null)} />
      )}
    </>
  );
}

/** The paired NAS's playlists: shared through it when it keeps them, else kept in this browser. */
function Playlists({ snap, wanted, onChosen }: { snap: Snapshot; wanted: string; onChosen: () => void }) {
  const [name, setName] = useState('');
  if (snap.openPlaylist && snap.playlists.some((playlist) => playlist.id === snap.openPlaylist)) {
    return <PlaylistView key={snap.openPlaylist} snap={snap} id={snap.openPlaylist} wanted={wanted} onChosen={onChosen} />;
  }
  if (snap.openShared && snap.sharedPlaylists.some((playlist) => sharedKey(playlist) === snap.openShared)) {
    return <SharedView key={snap.openShared} snap={snap} at={snap.openShared} wanted={wanted} onChosen={onChosen} />;
  }
  const others = snap.sharedPlaylists.filter((playlist) => !wanted || playlist.name.toLowerCase().includes(wanted) || playlist.owner.name.toLowerCase().includes(wanted));
  const shown = snap.playlists.filter((playlist) => !wanted || playlist.name.toLowerCase().includes(wanted));
  return (
    <>
      {snap.playlists.length === 0 && <p className="songs-note">No playlists yet. Name one below, or add a song to a new one from its folder. {playlistsKept(snap)}</p>}
      <ul>
        {shown.map((playlist) => (
          <li className="song-row" key={playlist.id}>
            <button type="button" className="song list" onClick={() => store.showPlaylist(playlist.id)}>
              <span className="song-lead">{LIST}<span className="sr-only">Playlist</span></span>
              <span className="song-title">{playlist.name}</span>
              <span className="song-detail">{ACCESS[playlist.access ?? 'private'].said}</span>
              <span className="song-meta">{playlist.tracks.length} {playlist.tracks.length === 1 ? 'song' : 'songs'}</span>
            </button>
          </li>
        ))}
      </ul>
      <form className="new-playlist menu-form" onSubmit={(e) => { e.preventDefault(); store.createPlaylist(name); setName(''); }}>
        <input type="text" value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="New playlist" aria-label="Name for a new playlist" maxLength={80} />
        <button className="plain-button" type="submit">Create playlist</button>
      </form>
      {snap.playlists.length > 0 && <p className="songs-note">{playlistsKept(snap)}</p>}
      {others.length > 0 && (
        <>
          <h3>From other people</h3>
          <ul>
            {others.map((playlist) => (
              <li className="song-row" key={sharedKey(playlist)}>
                <button type="button" className="song list" onClick={() => store.showShared(sharedKey(playlist))}>
                  <span className="song-lead">{LIST}<span className="sr-only">Playlist</span></span>
                  <span className="song-title">{playlist.name}</span>
                  <span className="song-detail">{playlist.owner.name}'s{playlist.access === 'collaborative' ? ', and yours to change' : ''}</span>
                  <span className="song-meta">{playlist.tracks.length} {playlist.tracks.length === 1 ? 'song' : 'songs'}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

const TAB_NAMES: Record<SongsTab, string> = { queue: 'Queue', folders: 'Folders', playlists: 'Playlists', device: 'This device', devices: 'Other devices' };

/** One of the user's other devices: what it is playing, and the means to steer it or to bring its music here. */
function OtherDevice({ device, onChosen }: { device: LiveDevice; onChosen: () => void }) {
  const state = device.state;
  // The time shown runs on between the device's words about itself.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!state?.playing) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [state?.playing]);
  const [dragged, setDragged] = useState<number | null>(null);
  const at = state ? store.remotePosition(state) : 0;
  const length = state?.duration ?? 0;
  const shown = dragged ?? at;
  return (
    <li className="device">
      <div className="device-name">{device.name}</div>
      {!state?.track && <p className="device-idle">Nothing from the NAS is playing there.</p>}
      {state?.track && (
        <>
          <div className="device-song">
            <span className="song-title">{state.track.title}</span>
            <span className="song-detail">{[state.track.artist, state.playing ? '' : 'paused'].filter(Boolean).join(', ')}</span>
          </div>
          <div className="device-seek">
            <output>{formatTime(shown)}</output>
            <input
              type="range" min={0} max={length || 1} step={1} value={Math.min(shown, length || 1)} disabled={!length}
              aria-label={`Position in the song on ${device.name}`}
              style={{ '--fill': `${length ? (Math.min(shown, length) / length) * 100 : 0}%` } as CSSProperties}
              onChange={(e) => setDragged(Number(e.currentTarget.value))}
              onPointerUp={() => { if (dragged !== null) void store.remote(device.id, 'seek', dragged); setDragged(null); }}
              onKeyUp={() => { if (dragged !== null) void store.remote(device.id, 'seek', dragged); setDragged(null); }}
            />
            <output>{formatTime(length)}</output>
          </div>
          <div className="actions">
            <button className="plain-button" type="button" onClick={() => void store.remote(device.id, 'previous')}>Previous</button>
            <button className="plain-button" type="button" onClick={() => void store.remote(device.id, state.playing ? 'pause' : 'play')}>{state.playing ? 'Pause' : 'Play'}</button>
            <button className="plain-button" type="button" onClick={() => void store.remote(device.id, 'next')}>Next</button>
            <button className="plain-button primary-button" type="button" onClick={() => { void store.playHere(device.id); onChosen(); }}>Play here</button>
          </div>
        </>
      )}
    </li>
  );
}

/** The user's other devices that have Taiko open. */
function Devices({ snap, onChosen }: { snap: Snapshot; onChosen: () => void }) {
  return (
    <>
      <p className="songs-note">Your other devices with Taiko open. Steer one from here, or bring what it is playing to this device.</p>
      <ul className="devices">
        {snap.devices.map((device) => <OtherDevice key={device.id} device={device} onChosen={onChosen} />)}
      </ul>
    </>
  );
}

/** What is playing and what comes after it, in order, for the listener to rearrange. */
function Queue({ snap }: { snap: Snapshot }) {
  const now = snap.currentTrack;
  if (!now) return null;
  const coming = store.upcoming();
  return (
    <>
      <h3>Playing now</h3>
      <ul>
        <SongRow text={{ ...rowText(now), lead: NOTE }} current onPlay={() => store.showLyrics()} />
      </ul>
      <h3>{coming.length ? 'Next' : snap.repeat === 'all' && snap.queue.length > 1 ? 'Next: the queue comes round again' : 'Nothing after this'}</h3>
      {coming.length === 0 && <p className="songs-note">Add songs with "Play next" or "Add to the queue", in the menu at the end of a song's row.</p>}
      <ul>
        {coming.map((track, index) => (
          <SongRow
            key={track.id}
            text={{ ...rowText(track), lead: index + 1 }}
            current={false}
            onPlay={() => void store.select(track.id)}
            menu={(
              <RowMenu label={`More for ${track.title}`}>{(close) => (
                <>
                  <button type="button" className="menu-item" disabled={index === 0} onClick={() => { store.moveInQueue(track.id, 'next'); close(); }}>Play next</button>
                  <button type="button" className="menu-item" disabled={index === 0} onClick={() => { store.moveInQueue(track.id, 'up'); close(); }}>Move up</button>
                  <button type="button" className="menu-item" disabled={index === coming.length - 1} onClick={() => { store.moveInQueue(track.id, 'down'); close(); }}>Move down</button>
                  <button type="button" className="menu-item" onClick={() => { store.removeFromQueue(track.id); close(); }}>Remove from the queue</button>
                </>
              )}</RowMenu>
            )}
          />
        ))}
      </ul>
      {coming.length > 1 && (
        <div className="actions queue-foot">
          <button className="plain-button" type="button" onClick={() => store.clearUpcoming()}>Clear what's next</button>
        </div>
      )}
    </>
  );
}

/** Every song the player can reach: the NAS folder by folder, the playlists, and the files picked on this device. */
export function SongsPanel({ snap, onClose }: { snap: Snapshot; onClose: () => void }) {
  const [filter, setFilter] = useState('');
  const wanted = filter.trim().toLowerCase();
  const tabs: SongsTab[] = [...(snap.pairing ? ['folders' as const, 'playlists' as const, ...(snap.tracks.length ? ['device' as const] : [])] : ['device' as const]), ...(snap.currentTrack ? ['queue' as const] : []), ...(snap.devices.length ? ['devices' as const] : [])];
  const tab = tabs.includes(snap.songsTab) ? snap.songsTab : tabs[0];
  const device = snap.tracks.filter((track) => !wanted || `${track.title}\n${track.artist}\n${track.album}`.toLowerCase().includes(wanted));
  const listed = tab === 'queue' || tab === 'devices' ? 0 : tab === 'device' ? snap.tracks.length
    : tab === 'folders' ? (snap.nasFolder ? snap.nasFolder.folders.length + snap.nasFolder.tracks.length : 0)
      : (snap.playlists.find((playlist) => playlist.id === snap.openPlaylist)?.tracks.length ?? snap.playlists.length);
  // On a phone the panel covers the screen, so choosing a song closes it.
  const closeIfNarrow = () => { if (matchMedia('(max-width: 44rem)').matches) onClose(); };

  return (
    <aside className="songs" aria-label="Songs">
      <div className="songs-head">
        <h2>Songs</h2>
        <button className="plain-button" type="button" onClick={onClose}>Close</button>
      </div>
      {tabs.length > 1 && (
        <div className="tabs" role="tablist" aria-label="Where to look for songs">
          {tabs.map((name) => (
            <button key={name} type="button" role="tab" aria-selected={name === tab} className={name === tab ? 'tab current' : 'tab'} onClick={() => { setFilter(''); store.setSongsTab(name); }}>{TAB_NAMES[name]}</button>
          ))}
        </div>
      )}
      {listed > 8 && (
        <input className="songs-filter" type="search" value={filter} onChange={(e) => setFilter(e.currentTarget.value)} placeholder="Filter what's listed" aria-label="Filter the songs and folders listed" />
      )}
      <div className="songs-scroll">
        {tab === 'queue' && <Queue snap={snap} />}
        {tab === 'devices' && <Devices snap={snap} onChosen={closeIfNarrow} />}
        {tab === 'folders' && <Folders snap={snap} wanted={wanted} onChosen={closeIfNarrow} />}
        {tab === 'playlists' && <Playlists snap={snap} wanted={wanted} onChosen={closeIfNarrow} />}
        {tab === 'device' && (
          <>
            {snap.tracks.length === 0 && <p className="songs-note">No songs yet. Add files, or pair with a NAS from the first screen.</p>}
            {snap.tracks.length > 0 && device.length === 0 && <p className="songs-note">No songs match the filter.</p>}
            <ul>
              {device.map((track) => (
                <SongRow
                  key={track.id}
                  text={{ ...rowText(track, hasLyrics(track)), detail: rowText(track).detail || track.fileName }}
                  current={track.id === snap.currentId}
                  onPlay={() => { void store.playFrom(snap.tracks, { kind: 'device' }, track.id); closeIfNarrow(); }}
                  menu={<RowMenu label={`More for ${track.title}`}>{(close) => <AddToPlaylist snap={snap} tracks={[track]} close={close} />}</RowMenu>}
                />
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="songs-foot">
        <button className="plain-button" type="button" onClick={async () => store.addFiles(await pickFiles())}>Add files</button>
        {canPickFolder() && <button className="plain-button" type="button" onClick={async () => store.addFiles(await pickFiles(true), true)}>Add a folder</button>}
        {tab === 'folders' && <button className="plain-button" type="button" onClick={() => void store.refreshNas()}>Refresh</button>}
        {tab === 'device' && snap.tracks.length > 0 && <ForgetSongs className="actions songs-forget" />}
      </div>
    </aside>
  );
}
