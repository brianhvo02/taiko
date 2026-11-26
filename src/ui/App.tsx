import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { store } from '../player/store';
import { FloatingLyrics, openFloatingWindow } from './FloatingLyrics';
import { LyricsView } from './LyricsView';
import { coverTint } from './tint';
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
  // Full-screen lyrics: nothing on the screen but the lyrics, until the listener stirs.
  const [wantFocus, setWantFocus] = useState(false);
  const focus = wantFocus && lyricsShown && snap.song !== null;
  const [awake, setAwake] = useState(false);
  const [tint, setTint] = useState<string | null>(null);
  // The lyrics in a small window of their own, above the other windows.
  const [floating, setFloating] = useState<Window | null>(null);
  const closeFloating = useCallback(() => setFloating(null), []);
  const float = async () => {
    if (floating) {
      floating.close();
      setFloating(null);
    } else {
      setFloating(await openFloatingWindow());
    }
  };
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
      // F puts the lyrics on the full screen, and takes them off it; Escape takes them off.
      if ((e.key === 'f' || e.key === 'F') && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) setWantFocus((on) => !on);
      if (e.key === 'Escape') setWantFocus(false);
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !typing) {
        e.preventDefault();
        store.seek(store.position() + (e.key === 'ArrowLeft' ? -5 : 5));
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // Entering full-screen lyrics asks the browser for the whole screen and to keep it lit; leaving gives both back.
  // A phone that has no whole-screen mode for pages still gets the lyrics alone on the page.
  useEffect(() => {
    if (!focus) return;
    // The button that was pressed lets go of the keyboard's attention, or the bar it sits in would never hide.
    (document.activeElement as HTMLElement | null)?.blur?.();
    let lock: { release(): Promise<void> } | null = null;
    const keepLit = () => {
      const wakeLock = (navigator as unknown as { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      void wakeLock?.request('screen').then((held) => { lock = held; }).catch(() => {});
    };
    keepLit();
    const onVisible = () => { if (document.visibilityState === 'visible') keepLit(); };
    document.addEventListener('visibilitychange', onVisible);
    void document.documentElement.requestFullscreen?.().catch(() => {});
    // Leaving the browser's full screen (Escape) leaves the lyrics' too.
    const onFullscreen = () => { if (!document.fullscreenElement) setWantFocus(false); };
    document.addEventListener('fullscreenchange', onFullscreen);
    // The controls show while the listener stirs, and go a few seconds after.
    let timer = 0;
    const stir = () => {
      setAwake(true);
      clearTimeout(timer);
      timer = window.setTimeout(() => setAwake(false), 3000);
    };
    stir();
    for (const type of ['pointermove', 'pointerdown', 'keydown'] as const) addEventListener(type, stir);
    return () => {
      clearTimeout(timer);
      for (const type of ['pointermove', 'pointerdown', 'keydown'] as const) removeEventListener(type, stir);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('fullscreenchange', onFullscreen);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      void lock?.release().catch(() => {});
    };
  }, [focus]);

  // The full-screen ground takes a quiet colour from the song's cover.
  useEffect(() => {
    let live = true;
    const cover = track?.cover ?? snap.songInfo?.artworkUrl100 ?? '';
    if (!focus || !cover) {
      setTint(null);
      return;
    }
    void coverTint(cover).then((colour) => { if (live) setTint(colour); });
    return () => { live = false; };
  }, [focus, track, snap.songInfo]);

  useEffect(() => {
    document.title = track ? `${snap.songInfo?.trackName ?? track.title} - Taiko` : 'Taiko';
  }, [track, snap.songInfo]);

  const classes = ['app', dragging && 'dragging', !snap.showRoman && 'no-roman', !snap.showTranslation && 'no-translation', songsOpen && 'songs-open', track && 'has-bar', focus && 'focus', focus && awake && 'awake']
    .filter(Boolean).join(' ');

  return (
    <div className={classes} style={tint ? { '--tint': tint } as CSSProperties : undefined}>
      {focus && (
        <>
          <div className="focus-ground" aria-hidden="true" />
          <header className="focus-head">
            <div className="focus-song">
              <span className="focus-title">{snap.songInfo?.trackName ?? track?.title}</span>
              <span className="focus-artist">{snap.songInfo?.artistName ?? track?.artist}</span>
            </div>
            <button className="plain-button" type="button" onClick={() => setWantFocus(false)}>Leave full screen</button>
          </header>
        </>
      )}
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
      {track && <TransportBar snap={snap} onFindSong={() => setCatalogOpen(true)} lyricsShown={lyricsShown && snap.song !== null} onFocus={() => setWantFocus(true)} floating={floating !== null} onFloat={() => void float()} />}
      {floating && <FloatingLyrics snap={snap} win={floating} onClosed={closeFloating} />}
      {catalogOpen && <CatalogDialog snap={snap} onClose={() => setCatalogOpen(false)} />}

      {songsOpen && <SongsPanel snap={snap} onClose={() => store.closeSongs()} />}
      <PairDialog snap={snap} />
    </div>
  );
}
