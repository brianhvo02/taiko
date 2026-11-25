import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Snapshot } from '../player/store';
import { store } from '../player/store';
import { formatTime, nowPlaying, pickFiles } from './format';

/** The bar's icons, drawn on a 24-unit grid in the text colour. A button's name comes from its hidden label. */
const SPEAKER = <path d="M3 9.5v5a1 1 0 0 0 1 1h3.2l4.15 3.32A1 1 0 0 0 13 18V6a1 1 0 0 0-1.65-.78L7.2 8.5H4a1 1 0 0 0-1 1Z" />;
const ICONS = {
  play: <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" />,
  pause: <path d="M6.5 4h3A1.5 1.5 0 0 1 11 5.5v13A1.5 1.5 0 0 1 9.5 20h-3A1.5 1.5 0 0 1 5 18.5v-13A1.5 1.5 0 0 1 6.5 4Zm8 0h3A1.5 1.5 0 0 1 19 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-3a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 14.5 4Z" />,
  previous: <path d="M5 5a1 1 0 0 1 2 0v5.7l10.45-6.53A1 1 0 0 1 19 5.02v13.96a1 1 0 0 1-1.55.85L7 13.3V19a1 1 0 0 1-2 0V5Z" />,
  next: <path d="M19 5a1 1 0 0 0-2 0v5.7L6.55 4.17A1 1 0 0 0 5 5.02v13.96a1 1 0 0 0 1.55.85L17 13.3V19a1 1 0 0 0 2 0V5Z" />,
  volume: (
    <>
      {SPEAKER}
      <path d="M15.8 8.3a.9.9 0 0 1 1.27.03 5.3 5.3 0 0 1 0 7.34.9.9 0 1 1-1.3-1.24 3.5 3.5 0 0 0 0-4.86.9.9 0 0 1 .03-1.27Z" />
      <path d="M18.4 5.6a.9.9 0 0 1 1.27.05 9.3 9.3 0 0 1 0 12.7.9.9 0 1 1-1.32-1.22 7.5 7.5 0 0 0 0-10.26.9.9 0 0 1 .05-1.27Z" />
    </>
  ),
  muted: (
    <>
      {SPEAKER}
      <path d="M16.14 9.14a.9.9 0 0 1 1.27 0L19 10.73l1.59-1.59a.9.9 0 1 1 1.27 1.27L20.27 12l1.59 1.59a.9.9 0 1 1-1.27 1.27L19 13.27l-1.59 1.59a.9.9 0 1 1-1.27-1.27L17.73 12l-1.59-1.59a.9.9 0 0 1 0-1.27Z" />
    </>
  ),
  options: (
    <>
      <path d="M4 7a1 1 0 0 1 1-1h6.18a3 3 0 0 1 5.64 0H19a1 1 0 1 1 0 2h-2.18a3 3 0 0 1-5.64 0H5a1 1 0 0 1-1-1Zm10-1a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z" />
      <path d="M4 17a1 1 0 0 1 1-1h2.18a3 3 0 0 1 5.64 0H19a1 1 0 1 1 0 2h-6.18a3 3 0 0 1-5.64 0H5a1 1 0 0 1-1-1Zm6-1a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z" />
    </>
  ),
  songs: <path d="M4 6.5a1.25 1.25 0 1 1 2.5 0 1.25 1.25 0 0 1-2.5 0ZM9 5.5h10a1 1 0 1 1 0 2H9a1 1 0 0 1 0-2ZM4 12a1.25 1.25 0 1 1 2.5 0A1.25 1.25 0 0 1 4 12Zm5-1h10a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2Zm-5 6.5a1.25 1.25 0 1 1 2.5 0 1.25 1.25 0 0 1-2.5 0Zm5-1h10a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2Z" />,
} satisfies Record<string, ReactNode>;

interface IconButtonProps {
  icon: keyof typeof ICONS;
  label: string;
  className?: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  controls?: string;
}

function IconButton(props: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-button ${props.className ?? ''}`.trim()}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.label}
      aria-pressed={props.pressed}
      aria-expanded={props.expanded}
      aria-controls={props.controls}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">{ICONS[props.icon]}</svg>
      <span className="sr-only">{props.label}</span>
    </button>
  );
}

/** How much of a slider's track is filled, for the stylesheet. */
const fillOf = (value: number, max: number) => `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%`;

/**
 * The player's bar: the song on the left, the transport over the seek bar in the middle, and on the right the
 * options, the Songs list and the volume. On a phone the three stack.
 */
export function TransportBar({ snap }: { snap: Snapshot }) {
  const seekRef = useRef<HTMLInputElement>(null);
  const elapsedRef = useRef<HTMLOutputElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const now = nowPlaying(snap);
  const at = snap.queue.findIndex((track) => track.id === snap.currentId);

  // The seek bar and the clock follow the audio every frame, without re-rendering.
  useEffect(() => {
    let frame = 0;
    let shownSecond = -1;
    const tick = () => {
      const time = store.position();
      const seek = seekRef.current;
      if (seek) {
        if (!dragging.current) seek.value = String(time);
        seek.style.setProperty('--fill', fillOf(Number(seek.value), Number(seek.max)));
      }
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

  // The options close when the listener clicks elsewhere or presses Escape.
  useEffect(() => {
    if (!optionsOpen) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !optionsRef.current?.contains(e.target as Node)) setOptionsOpen(false);
    };
    addEventListener('click', close);
    addEventListener('keydown', close);
    return () => {
      removeEventListener('click', close);
      removeEventListener('keydown', close);
    };
  }, [optionsOpen]);

  const writers = snap.song?.writers ?? [];
  const artist = now ? now.artist + (now.otherArtist ? ` (${now.otherArtist})` : '') : '';
  const by = writers.length ? `ritten by ${writers.join(', ')}` : '';
  const credit = artist ? [artist, by && `w${by}`].filter(Boolean).join(', ') : by && `W${by}`;
  const offsetText = snap.offset === 0 ? 'Lyrics in sync' : `${Math.abs(snap.offset).toFixed(2)} s ${snap.offset > 0 ? 'later' : 'earlier'}`;
  const level = snap.muted ? 0 : snap.volume;

  const volume = snap.canSetVolume && (
    <div className="volume">
      <IconButton icon={level === 0 ? 'muted' : 'volume'} label={snap.muted ? 'Unmute' : 'Mute'} pressed={snap.muted} onClick={() => store.toggleMute()} />
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={level}
        style={{ '--fill': fillOf(level, 1) } as CSSProperties}
        aria-label="Volume"
        onChange={(e) => store.setVolume(Number(e.currentTarget.value))}
      />
    </div>
  );

  return (
    <footer className="bar">
      <div className="now-zone">
        {now?.art && <img className="art" src={now.art} alt="" />}
        <div className="now">
          <div className="now-title">
            {now?.link ? <a href={now.link} target="_blank" rel="noopener" title="Open in Apple Music">{now.title}</a> : now?.title}
            {now?.otherTitle && <span className="other-name"> ({now.otherTitle})</span>}
          </div>
          <div className="credit">{credit}</div>
        </div>
      </div>

      <div className="center-zone">
        <div className="transport">
          <IconButton icon="previous" label="Previous" onClick={() => store.step(-1)} />
          <IconButton icon={snap.playing ? 'pause' : 'play'} label={snap.playing ? 'Pause' : 'Play'} className="play" onClick={() => store.toggle()} />
          <IconButton icon="next" label="Next" onClick={() => store.step(1)} disabled={at < 0 || at >= snap.queue.length - 1} />
        </div>
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
      </div>

      <div className="side-zone">
        <div className="options" ref={optionsRef}>
          <IconButton icon="options" label="Options" expanded={optionsOpen} controls="extras" onClick={() => setOptionsOpen(!optionsOpen)} />
          {optionsOpen && (
            <div className="extras" id="extras" role="group" aria-label="Options">
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
              <button className="plain-button" type="button" onClick={async () => store.addFiles(await pickFiles())}>Add lyrics or music</button>
              {volume && <div className="extras-volume">{volume}</div>}
            </div>
          )}
        </div>
        <IconButton icon="songs" label="Songs" pressed={snap.songsOpen} onClick={() => (snap.songsOpen ? store.closeSongs() : store.openSongs())} />
        {volume}
      </div>
    </footer>
  );
}
