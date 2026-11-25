import { useEffect, useState, useSyncExternalStore } from 'react';
import { store } from '../player/store';
import { LyricsView } from './LyricsView';
import { SearchBar } from './SearchBar';
import { SongsPanel } from './SongsPanel';
import { PairDialog, StartScreen } from './StartScreen';
import { TransportBar } from './TransportBar';
import { pickFiles } from './format';

export function App() {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [songsOpen, setSongsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const track = snap.currentTrack;
  const playing = track !== null;

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
        store.seek(store.audio.currentTime + (e.key === 'ArrowLeft' ? -5 : 5));
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    document.title = track ? `${snap.songInfo?.trackName ?? track.title} - Taiko` : 'Taiko';
  }, [track, snap.songInfo]);

  const classes = ['app', dragging && 'dragging', !snap.showRoman && 'no-roman', !snap.showTranslation && 'no-translation', songsOpen && 'songs-open']
    .filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <header className="top">
        <a className="brand" href="./" aria-label="Taiko"><span lang="ja">太鼓</span> Taiko</a>
        <SearchBar snap={snap} />
        {(snap.tracks.length > 0 || snap.pairing) && <button className="plain-button songs-button" type="button" onClick={() => setSongsOpen(!songsOpen)} aria-expanded={songsOpen}>Songs</button>}
      </header>

      {!playing && <StartScreen snap={snap} onShowSongs={() => setSongsOpen(true)} />}

      {playing && (
        <>
          {snap.song && <LyricsView song={snap.song} />}
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
          {snap.notice && (
            <p className="toast notice" role="status">
              {snap.notice} <button className="text-button" type="button" onClick={() => store.dismissNotice()}>Dismiss</button>
            </p>
          )}
          <TransportBar snap={snap} onShowSongs={() => setSongsOpen(true)} />
        </>
      )}

      {songsOpen && <SongsPanel snap={snap} onClose={() => setSongsOpen(false)} />}
      <PairDialog snap={snap} />
    </div>
  );
}
