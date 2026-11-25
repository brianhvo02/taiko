import { useEffect, useState, useSyncExternalStore } from 'react';
import { store } from '../player/store';
import { LyricsView } from './LyricsView';
import { CatalogDialog } from './SearchBar';
import { SongsPanel } from './SongsPanel';
import { PairDialog, StartScreen } from './StartScreen';
import { TransportBar } from './TransportBar';
import { pickFiles } from './format';

export function App() {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const songsOpen = snap.songsOpen;
  const [dragging, setDragging] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const track = snap.currentTrack;
  const lyricsShown = track !== null && snap.view === 'lyrics';
  // The library takes the first screen over once there is something in it, or a NAS that may have something.
  const stocked = snap.tracks.length > 0 || snap.offline.sets.length > 0 || snap.page.kind !== 'home' || snap.libraryQuery.trim() !== ''
    || (snap.pairing !== null && (snap.library.albums.length > 0 || snap.library.scanning || snap.library.state === 'idle' || snap.library.state === 'loading'));

  // Files dropped anywhere on the page are added.
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => { e.preventDefault(); depth++; setDragging(true); };
    const leave = () => { if (--depth <= 0) { depth = 0; setDragging(false); } };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (e.dataTransfer?.files.length) void store.addFiles(Array.from(e.dataTransfer.files));
    };
    addEventListener('dragenter', enter);
    addEventListener('dragleave', leave);
    addEventListener('dragover', over);
    addEventListener('drop', drop);
    return () => {
      removeEventListener('dragenter', enter);
      removeEventListener('dragleave', leave);
      removeEventListener('dragover', over);
      removeEventListener('drop', drop);
    };
  }, []);

  // Space plays and pauses; the left and right arrows jump five seconds.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      if (e.key === ' ' && !typing && tag !== 'BUTTON') { e.preventDefault(); store.toggle(); }
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !typing) {
        e.preventDefault();
        store.seek(store.position() + (e.key === 'ArrowLeft' ? -5 : 5));
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    document.title = track ? `${snap.songInfo?.trackName ?? track.title} - Taiko` : 'Taiko';
  }, [track, snap.songInfo]);

  const classes = ['app', dragging && 'dragging', !snap.showRoman && 'no-roman', !snap.showTranslation && 'no-translation', songsOpen && 'songs-open', track && 'has-bar']
    .filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <header className="top">
        <a className="brand" href="/" aria-label="Taiko" onClick={(e) => { e.preventDefault(); store.showHome(); }}><span lang="ja">太鼓</span> Taiko</a>
        {track && (
          <nav className="views" aria-label="Views">
            <button type="button" className="view" aria-current={lyricsShown ? undefined : 'page'} onClick={() => (lyricsShown ? store.showLibrary() : store.showHome())}>Library</button>
            <button type="button" className="view" aria-current={lyricsShown ? 'page' : undefined} onClick={() => store.showLyrics()}>Lyrics</button>
          </nav>
        )}
        {stocked && (
          <input
            className="library-search"
            type="search"
            value={snap.libraryQuery}
            onChange={(e) => store.setLibraryQuery(e.currentTarget.value)}
            placeholder="Search your library"
            aria-label="Search your library"
            autoComplete="off"
            enterKeyHint="search"
          />
        )}
      </header>

      {!lyricsShown && <StartScreen snap={snap} stocked={stocked} quietNotice={track !== null || stocked} onShowSongs={() => store.openSongs('folders')} />}

      {lyricsShown && (
        <>
          {snap.song && <LyricsView song={snap.song} />}
          {snap.song && snap.song.timed && !snap.song.wordTimed && <p className="timing-note">These lyrics are timed by line, not by word</p>}
          {snap.song && !snap.song.timed && <p className="timing-note">These lyrics have no timing, so they don't follow the song</p>}
          {!snap.song && (
            <main className="no-lyrics">
              {snap.lyricsLoading ? <p>Loading lyrics</p> : (
                <>
                  <h1>{track?.title}</h1>
                  <p>This song has no lyrics yet. Add its lyrics file (Apple Music JSON, TTML or LRC) and they follow the music.</p>
                  <button className="plain-button" type="button" onClick={async () => store.addFiles(await pickFiles())}>Add a lyrics file</button>
                </>
              )}
            </main>
          )}
        </>
      )}
      {snap.notice && (track !== null || stocked) && (
        <p className="toast notice" role="status">
          {snap.notice} <button className="text-button" type="button" onClick={() => store.dismissNotice()}>Dismiss</button>
        </p>
      )}
      {track && <TransportBar snap={snap} onFindSong={() => setCatalogOpen(true)} />}
      {catalogOpen && <CatalogDialog snap={snap} onClose={() => setCatalogOpen(false)} />}

      {songsOpen && <SongsPanel snap={snap} onClose={() => store.closeSongs()} />}
      <PairDialog snap={snap} />
    </div>
  );
}
