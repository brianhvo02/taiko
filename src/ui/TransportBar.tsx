import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../player/store';
import { store } from '../player/store';
import { formatTime, nowPlaying, pickFiles } from './format';

export function TransportBar({ snap, onShowSongs }: { snap: Snapshot; onShowSongs: () => void }) {
  const seekRef = useRef<HTMLInputElement>(null);
  const elapsedRef = useRef<HTMLOutputElement>(null);
  const dragging = useRef(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const now = nowPlaying(snap);
  const at = snap.queue.findIndex((track) => track.id === snap.currentId);

  // The seek bar and the clock follow the audio every frame, without re-rendering.
  useEffect(() => {
    let frame = 0;
    let shownSecond = -1;
    const tick = () => {
      const time = store.audio.currentTime;
      if (seekRef.current && !dragging.current) seekRef.current.value = String(time);
      const second = Math.floor(time);
      if (second !== shownSecond && elapsedRef.current) {
        shownSecond = second;
        elapsedRef.current.textContent = formatTime(second);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const release = () => { dragging.current = false; };
    addEventListener('pointerup', release);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener('pointerup', release);
    };
  }, []);

  const writers = snap.song?.writers ?? [];
  const artist = now ? now.artist + (now.otherArtist ? ` (${now.otherArtist})` : '') : '';
  const by = writers.length ? `ritten by ${writers.join(', ')}` : '';
  const credit = artist ? [artist, by && `w${by}`].filter(Boolean).join(', ') : by && `W${by}`;
  const offsetText = snap.offset === 0 ? 'Lyrics in sync' : `${Math.abs(snap.offset).toFixed(2)} s ${snap.offset > 0 ? 'later' : 'earlier'}`;

  return (
    <footer className="bar">
      <div className="seek-row">
        <output ref={elapsedRef}>0:00</output>
        <input
          ref={seekRef}
          type="range"
          min={0}
          max={snap.duration || 1}
          step={0.01}
          defaultValue={0}
          aria-label="Position in song"
          disabled={!snap.duration}
          onPointerDown={() => { dragging.current = true; }}
          onChange={(e) => store.seek(Number(e.currentTarget.value))}
        />
        <output>{formatTime(snap.duration)}</output>
      </div>
      <div className="control-row">
        {now?.art && <img className="art" src={now.art} alt="" />}
        <div className="now">
          <div className="now-title">
            {now?.link ? <a href={now.link} target="_blank" rel="noopener" title="Open in Apple Music">{now.title}</a> : now?.title}
            {now?.otherTitle && <span className="other-name"> ({now.otherTitle})</span>}
          </div>
          <div className="credit">{credit}</div>
        </div>
        <div className="transport">
          <button className="plain-button" type="button" onClick={() => store.step(-1)} aria-label="Previous song or start of this song">Back</button>
          <button className="plain-button primary-button play" type="button" onClick={() => store.toggle()}>{snap.playing ? 'Pause' : 'Play'}</button>
          <button className="plain-button" type="button" onClick={() => store.step(1)} disabled={at < 0 || at >= snap.queue.length - 1}>Next</button>
        </div>
        <button className="plain-button more" type="button" aria-expanded={optionsOpen} aria-controls="extras" onClick={() => setOptionsOpen(!optionsOpen)}>Options</button>
        <div className={optionsOpen ? 'extras open' : 'extras'} id="extras">
          {snap.song?.hasRoman && (
            <label className="toggle"><input type="checkbox" checked={snap.showRoman} onChange={(e) => store.setShowRoman(e.currentTarget.checked)} /> Romanization</label>
          )}
          {snap.song?.hasTranslation && (
            <label className="toggle"><input type="checkbox" checked={snap.showTranslation} onChange={(e) => store.setShowTranslation(e.currentTarget.checked)} /> Translation</label>
          )}
          {snap.song && (
            <div className="timing" role="group" aria-label="Lyric timing">
              <button className="plain-button" type="button" onClick={() => store.nudge(-0.05)}>Earlier</button>
              <output>{offsetText}</output>
              <button className="plain-button" type="button" onClick={() => store.nudge(0.05)}>Later</button>
            </div>
          )}
          {snap.lyricsNames.length > 1 && (
            <button className="plain-button" type="button" title="Save the combined lyrics as one file" onClick={() => store.downloadLyrics()}>Download lyrics</button>
          )}
          <button className="plain-button narrow-only" type="button" onClick={async () => store.addFiles(await pickFiles())}>Add lyrics or music</button>
          <button className="plain-button narrow-only" type="button" onClick={onShowSongs}>Songs</button>
        </div>
      </div>
    </footer>
  );
}
