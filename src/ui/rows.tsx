import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Track } from '../library/tracks';
import type { SavedTrack } from '../player/persist';
import type { Snapshot } from '../player/store';
import { store } from '../player/store';
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

/** A menu's contents for putting songs in a playlist: the playlists there are, and a place to name a new one. */
export function AddToPlaylist({ snap, tracks, close }: { snap: Snapshot; tracks: Track[]; close: () => void }) {
  const [name, setName] = useState('');
  return (
    <>
      <div className="menu-heading">Add to a playlist</div>
      {snap.playlists.map((playlist) => (
        <button type="button" className="menu-item" key={playlist.id} onClick={() => { store.addToPlaylist(playlist.id, tracks); close(); }}>{playlist.name}</button>
      ))}
      <form className="menu-form" onSubmit={(e) => { e.preventDefault(); store.createPlaylist(name, tracks, false); close(); }}>
        <input type="text" value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="New playlist" aria-label="Name for a new playlist" maxLength={80} />
        <button className="plain-button" type="submit">Create</button>
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

