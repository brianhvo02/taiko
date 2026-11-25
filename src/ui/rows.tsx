import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Track } from '../library/tracks';
import type { SavedTrack } from '../player/persist';
import type { Snapshot } from '../player/store';
import { sharedKey, store } from '../player/store';
import type { PlaylistAccess } from '../shared/playlists';
import { formatTime, otherForms } from './format';

/** A song's row, its "more" menu and adding to a playlist: used by the Songs panel and by the library. */

export const icon = (path: ReactNode) => <svg viewBox="0 0 24 24" aria-hidden="true">{path}</svg>;
// What a row leads with when it has no track number, for a folder, and for a playlist.
export const NOTE = icon(<path d="M10 4.5a1 1 0 0 1 .76-.97l8-2A1 1 0 0 1 20 2.5V15.5a3.5 3.5 0 1 1-2-3.16V7.28l-6 1.5V17.5a3.5 3.5 0 1 1-2-3.16V4.5Z" transform="translate(-1 2) scale(.92)" />);
export const FOLDER = icon(<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.38a2.5 2.5 0 0 1 1.77.73L11.91 6H18.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Z" />);
export const LIST = icon(<path d="M4 6.5a1.25 1.25 0 1 1 2.5 0 1.25 1.25 0 0 1-2.5 0ZM9 5.5h10a1 1 0 1 1 0 2H9a1 1 0 0 1 0-2ZM4 12a1.25 1.25 0 1 1 2.5 0A1.25 1.25 0 0 1 4 12Zm5-1h10a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2Zm-5 6.5a1.25 1.25 0 1 1 2.5 0 1.25 1.25 0 0 1-2.5 0Zm5-1h10a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2Z" />);
export const MORE = icon(<path d="M6 10.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Zm6 0a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Zm6 0a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Z" />);

/** What a song's row says, whether the song is a track or one stored in a playlist. */
export interface RowText {
  lead: ReactNode;
  title: string;
  detail: string;
  meta: string;
}

export function rowText(song: Track | SavedTrack, withLyrics = false): RowText {
  // Under a title in another script goes its reading and English name; otherwise who and what it is from.
  const detail = otherForms(song.title, song.titleRoman, song.titleEnglish) || [song.artist, song.album].filter(Boolean).join(', ');
  const length = song.durationSeconds ? formatTime(song.durationSeconds) : '';
  return { lead: song.trackNumber ?? NOTE, title: song.title, detail, meta: [withLyrics ? 'Lyrics' : '', length].filter(Boolean).join(', ') };
}

/** A small menu that opens from a row's "more" button and closes on a click elsewhere or Escape. */
export function RowMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener('click', close);
    addEventListener('keydown', close);
    return () => {
      removeEventListener('click', close);
      removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="row-menu" ref={ref}>
      <button type="button" className="icon-button" title={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        {MORE}
        <span className="sr-only">{label}</span>
      </button>
      {open && <div className="menu" role="group" aria-label={label}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

// A heart: an outline for "not yet", filled for a favourite.
export const HEART = icon(<path d="M12 20.3 4.9 13.4a4.9 4.9 0 0 1 0-7 5 5 0 0 1 7.1 0 5 5 0 0 1 7.1 0 4.9 4.9 0 0 1 0 7L12 20.3Zm0-2.800 5.700-5.500a2.900 2.900 0 0 0 0-4.200 3 3 0 0 0-4.200 0L12 9.200l-1.500-1.400a3 3 0 0 0-4.200 0 2.900 2.900 0 0 0 0 4.200L12 17.500Z" />);
export const HEART_ON = icon(<path d="M12 20.3 4.9 13.4a4.9 4.9 0 0 1 0-7 5 5 0 0 1 7.1 0 5 5 0 0 1 7.1 0 4.9 4.9 0 0 1 0 7L12 20.3Z" />);

// Lines of a list with an arrow into its top, and into its bottom: where a queued song goes.
const PLAY_NEXT = icon(<path d="M3 5.500 8 9 3 12.500v-7ZM11 6h10a1 1 0 1 1 0 2H11a1 1 0 1 1 0-2Zm0 5.500h10a1 1 0 1 1 0 2H11a1 1 0 1 1 0-2ZM4 17h17a1 1 0 1 1 0 2H4a1 1 0 1 1 0-2Z" />);
const PLAY_LAST = icon(<path d="M4 5h17a1 1 0 1 1 0 2H4a1 1 0 0 1 0-2Zm7 5.500h10a1 1 0 1 1 0 2H11a1 1 0 1 1 0-2Zm0 5.500h10a1 1 0 1 1 0 2H11a1 1 0 1 1 0-2ZM3 11.500 8 15l-5 3.500v-7Z" />);

const PLUS = icon(<path d="M12 4.5a1 1 0 0 1 1 1V11h5.5a1 1 0 1 1 0 2H13v5.5a1 1 0 1 1-2 0V13H5.500a1 1 0 1 1 0-2H11V5.500a1 1 0 0 1 1-1Z" />);

const songs = (n: number) => `${n} ${n === 1 ? 'song' : 'songs'}`;

/**
 * A song's menu (or an album's): play it next or last, mark it a favourite, and put it in a playlist: the
 * listener's own, the ones other people let everyone add to, or a new one named on the last line.
 */
export function AddToPlaylist({ snap, tracks, close }: { snap: Snapshot; tracks: Track[]; close: () => void }) {
  const one = tracks.length === 1 && tracks[0].nas ? tracks[0] : null;
  const loved = one?.nas ? store.isFavouriteSong(one.nas.id) : false;
  // Playlists hold NAS songs only; a song from this device can still be queued.
  const onNas = snap.pairing !== null && tracks.some((track) => track.nas);
  return (
    <>
      <div className="menu-part">
        <button type="button" className="menu-item menu-pick" onClick={() => { store.enqueue(tracks, true); close(); }}>
          <span className="menu-pick-lead">{PLAY_NEXT}</span>
          <span className="menu-pick-name">Play next</span>
        </button>
        <button type="button" className="menu-item menu-pick" onClick={() => { store.enqueue(tracks, false); close(); }}>
          <span className="menu-pick-lead">{PLAY_LAST}</span>
          <span className="menu-pick-name">Add to the queue</span>
        </button>
        {one && snap.favourites && (
          <button type="button" className="menu-item menu-pick menu-favourite" onClick={() => { void store.toggleFavouriteSong(one); close(); }}>
            <span className="menu-pick-lead">{loved ? HEART_ON : HEART}</span>
            <span className="menu-pick-name">{loved ? 'Remove from favourites' : 'Add to favourites'}</span>
          </button>
        )}
      </div>
      {onNas && <PlaylistPicks snap={snap} tracks={tracks} close={close} />}
    </>
  );
}

function PlaylistPicks({ snap, tracks, close }: { snap: Snapshot; tracks: Track[]; close: () => void }) {
  const [name, setName] = useState('');
  const open = snap.sharedPlaylists.filter((playlist) => playlist.access === 'collaborative');
  return (
    <>
      <div className="menu-heading">Add to a playlist</div>
      {snap.playlists.map((playlist) => (
        <button type="button" className="menu-item menu-pick" key={playlist.id} onClick={() => { store.addToPlaylist(playlist.id, tracks); close(); }}>
          <span className="menu-pick-lead">{LIST}</span>
          <span className="menu-pick-name">{playlist.name}</span>
          <span className="menu-pick-detail">{songs(playlist.tracks.length)}</span>
        </button>
      ))}
      {open.map((playlist) => (
        <button type="button" className="menu-item menu-pick" key={sharedKey(playlist)} onClick={() => { void store.addToShared(sharedKey(playlist), tracks); close(); }}>
          <span className="menu-pick-lead">{LIST}</span>
          <span className="menu-pick-name">{playlist.name}</span>
          <span className="menu-pick-detail">{playlist.owner.name}'s</span>
        </button>
      ))}
      <form className="menu-new" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; store.createPlaylist(name, tracks, false); close(); }}>
        <span className="menu-pick-lead">{PLUS}</span>
        <input type="text" value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="New playlist" aria-label="Name for a new playlist" maxLength={80} />
        <button className="text-button" type="submit" disabled={!name.trim()}>Create</button>
      </form>
    </>
  );
}

/** Forgets the songs picked on this device, after asking. They are copies in the browser; the files themselves stay. */
export function ForgetSongs({ className = 'actions' }: { className?: string }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <button className="plain-button" type="button" onClick={() => setAsking(true)}>Forget these songs</button>;
  return (
    <div className={className} role="alert">
      <span>Forget these songs? The copies kept in this browser go; your files stay where they are.</span>
      <button className="plain-button" type="button" onClick={() => { setAsking(false); void store.forgetDeviceSongs(); }}>Forget them</button>
      <button className="plain-button" type="button" onClick={() => setAsking(false)}>Keep them</button>
    </div>
  );
}

/** Where the playlists live: on the NAS for every paired device when it keeps them, else in this browser alone. */
export const playlistsKept = (snap: Snapshot): string =>
  snap.playlistsShared ? `Your playlists are kept on ${snap.pairing?.serverName ?? 'the NAS'}, for all of your devices.` : 'Playlists are kept in this browser.';

/** Who but its owner may use a playlist, as the owner chooses it and as a row says it. */
export const ACCESS: Record<PlaylistAccess, { choice: string; said: string }> = {
  private: { choice: 'Only you', said: '' },
  public: { choice: 'Everyone can play it', said: 'Everyone can play it' },
  collaborative: { choice: 'Everyone can change it', said: 'Everyone can change it' },
};

/** The two lines that queue a stored song, for menus that aren't the full song menu. */
export function QueueItems({ song, close }: { song: SavedTrack; close: () => void }) {
  return (
    <>
      <button type="button" className="menu-item" onClick={() => { store.enqueueSaved([song], true); close(); }}>Play next</button>
      <button type="button" className="menu-item" onClick={() => { store.enqueueSaved([song], false); close(); }}>Add to the queue</button>
    </>
  );
}

export function SongRow({ text, current, onPlay, menu }: { text: RowText; current: boolean; onPlay: () => void; menu?: ReactNode }) {
  return (
    <li className="song-row">
      <button type="button" className={current ? 'song current' : 'song'} aria-current={current || undefined} onClick={onPlay}>
        <span className="song-lead">{text.lead}</span>
        <span className="song-title">{text.title}</span>
        <span className="song-detail">{text.detail}</span>
        <span className="song-meta">{text.meta}</span>
      </button>
      {menu}
    </li>
  );
}

export const hasLyrics = (track: Track) => track.lyricFiles.length > 0 || (track.nas?.lyrics.length ?? 0) > 0;

