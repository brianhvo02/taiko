import { useState } from 'react';
import type { Track } from '../library/tracks';
import type { Snapshot } from '../player/store';
import { store } from '../player/store';
import { canPickFolder, formatTime, otherForms, pickFiles } from './format';

// What a row leads with when it has no track number, and for a folder.
const NOTE = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4.5a1 1 0 0 1 .76-.97l8-2A1 1 0 0 1 20 2.5V15.5a3.5 3.5 0 1 1-2-3.16V7.28l-6 1.5V17.5a3.5 3.5 0 1 1-2-3.16V4.5Z" transform="translate(-1 2) scale(.92)" /></svg>;
const FOLDER = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.38a2.5 2.5 0 0 1 1.77.730L11.91 6H18.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Z" /></svg>;

function SongRow({ track, current, onChosen }: { track: Track; current: boolean; onChosen: () => void }) {
  const hasLyrics = track.lyricFiles.length > 0 || (track.nas?.lyrics.length ?? 0) > 0;
  // Under a title in another script goes its reading and English name; otherwise who and what it is from.
  const detail = otherForms(track.title, track.titleRoman, track.titleEnglish) || [track.artist, track.album].filter(Boolean).join(', ');
  return (
    <li>
      <button type="button" className={current ? 'song current' : 'song'} aria-current={current || undefined} onClick={() => { void store.select(track.id); onChosen(); }}>
        <span className="song-lead">{track.trackNumber ?? NOTE}</span>
        <span className="song-title">{track.title}</span>
        <span className="song-detail">{detail || (track.origin === 'device' ? track.fileName : '')}</span>
        <span className="song-meta">
          {hasLyrics ? 'Lyrics' : ''}
          {hasLyrics && track.durationSeconds ? ', ' : ''}
          {track.durationSeconds ? formatTime(track.durationSeconds) : ''}
        </span>
      </button>
    </li>
  );
}

/** The paired NAS, browsed folder by folder. Choosing a song plays it, and Back and Next then walk its folder. */
function NasBrowser({ snap, wanted, onChosen }: { snap: Snapshot; wanted: string; onChosen: () => void }) {
  const folder = snap.nasFolder;
  const segments = folder?.path ? folder.path.split('/') : [];
  const matches = (name: string) => !wanted || name.toLowerCase().includes(wanted);
  const folders = folder?.folders.filter((entry) => matches(entry.name)) ?? [];
  const tracks = folder?.tracks.filter((track) => matches(track.title)) ?? [];
  const empty = folder && folders.length === 0 && tracks.length === 0;

  return (
    <>
      <h3>From {snap.pairing?.serverName}</h3>
      <nav className="crumbs" aria-label="Folder">
        <button className="text-button" type="button" onClick={() => void store.browse('')} disabled={segments.length === 0}>All folders</button>
        {segments.map((name, i) => (
          <span key={i}>
            <span aria-hidden="true"> / </span>
            <button className="text-button" type="button" onClick={() => void store.browse(segments.slice(0, i + 1).join('/'))} disabled={i === segments.length - 1}>{name}</button>
          </span>
        ))}
      </nav>
      {folder?.cover && (
        <div className="album">
          <img className="folder-cover" src={folder.cover} alt="" />
          <div className="album-name">{segments[segments.length - 1]}</div>
        </div>
      )}
      {snap.nasState === 'loading' && !folder && <p className="songs-note">Opening the NAS</p>}
      {snap.nasState === 'error' && <p className="songs-note">The folder didn't open. <button className="text-button" type="button" onClick={() => void store.refreshNas()}>Try again</button></p>}
      {empty && <p className="songs-note">{wanted ? 'Nothing here matches the filter.' : 'This folder has no songs or folders.'}</p>}
      <ul className={snap.nasState === 'loading' ? 'busy' : undefined}>
        {folders.map((entry) => (
          <li key={entry.path}>
            <button type="button" className="song folder" onClick={() => void store.browse(entry.path)}>
              <span className="song-lead">{FOLDER}<span className="sr-only">Folder</span></span>
              <span className="song-title">{entry.name}</span>
            </button>
          </li>
        ))}
        {tracks.map((track) => <SongRow key={track.id} track={track} current={track.id === snap.currentId} onChosen={onChosen} />)}
      </ul>
    </>
  );
}

/** Every song the player can reach: the files picked on this device, then the paired NAS's folders. */
export function SongsPanel({ snap, onClose }: { snap: Snapshot; onClose: () => void }) {
  const [filter, setFilter] = useState('');
  const wanted = filter.trim().toLowerCase();
  const device = snap.tracks.filter((track) => !wanted || `${track.title}\n${track.artist}\n${track.album}`.toLowerCase().includes(wanted));
  const listed = snap.tracks.length + (snap.nasFolder ? snap.nasFolder.folders.length + snap.nasFolder.tracks.length : 0);
  // On a phone the panel covers the screen, so choosing a song closes it.
  const closeIfNarrow = () => { if (matchMedia('(max-width: 44rem)').matches) onClose(); };

  return (
    <aside className="songs" aria-label="Songs">
      <div className="songs-head">
        <h2>Songs</h2>
        <button className="plain-button" type="button" onClick={onClose}>Close</button>
      </div>
      {listed > 8 && (
        <input className="songs-filter" type="search" value={filter} onChange={(e) => setFilter(e.currentTarget.value)} placeholder="Filter what's listed" aria-label="Filter the songs and folders listed" />
      )}
      <div className="songs-scroll">
        {snap.tracks.length > 0 && (
          <>
            <h3>On this device</h3>
            {device.length === 0 && <p className="songs-note">No songs match the filter.</p>}
            <ul>{device.map((track) => <SongRow key={track.id} track={track} current={track.id === snap.currentId} onChosen={closeIfNarrow} />)}</ul>
          </>
        )}
        {snap.pairing && <NasBrowser snap={snap} wanted={wanted} onChosen={closeIfNarrow} />}
        {!snap.pairing && snap.tracks.length === 0 && <p className="songs-note">No songs yet. Add files, or pair with a NAS from the first screen.</p>}
      </div>
      <div className="songs-foot">
        <button className="plain-button" type="button" onClick={async () => store.addFiles(await pickFiles())}>Add files</button>
        {canPickFolder() && <button className="plain-button" type="button" onClick={async () => store.addFiles(await pickFiles(true), true)}>Add a folder</button>}
        {snap.pairing && <button className="plain-button" type="button" onClick={() => void store.refreshNas()}>Refresh</button>}
      </div>
    </aside>
  );
}
