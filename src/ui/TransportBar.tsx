import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Snapshot } from '../player/store';
import { store } from '../player/store';
import { canFloat } from './FloatingLyrics';
import { formatTime, nowPlaying, pickFiles, qualityOf } from './format';

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
  shuffle: (
    <>
      <path d="M3 7a1 1 0 0 1 1-1h2.34a5 5 0 0 1 4.16 2.22l3.66 5.5A3 3 0 0 0 16.66 15H17.59l-.800-.790a1 1 0 0 1 1.42-1.42l2.5 2.5a1 1 0 0 1 0 1.42l-2.5 2.5a1 1 0 1 1-1.42-1.42l.800-.790h-.930a5 5 0 0 1-4.16-2.22l-3.66-5.5A3 3 0 0 0 6.34 8H4a1 1 0 0 1-1-1Z" />
      <path d="M16.79 5.21a1 1 0 0 1 1.42 0l2.5 2.5a1 1 0 0 1 0 1.42l-2.5 2.5a1 1 0 1 1-1.42-1.42l.800-.790h-.930a3 3 0 0 0-2.16.920l-1.2-1.8A5 5 0 0 1 16.66 7H17.59l-.800-.790a1 1 0 0 1 0-1ZM3 17a1 1 0 0 1 1-1h2.34a3 3 0 0 0 2.16-.920l1.2 1.8A5 5 0 0 1 6.34 18H4a1 1 0 0 1-1-1Z" />
    </>
  ),
  repeat: <path d="M16.29 2.79a1 1 0 0 1 1.42 0l2.5 2.5a1 1 0 0 1 0 1.42l-2.5 2.5a1 1 0 1 1-1.42-1.42L17.09 7H8a3 3 0 0 0-3 3v1a1 1 0 1 1-2 0v-1a5 5 0 0 1 5-5h9.09l-.800-.790a1 1 0 0 1 0-1.42ZM20 12a1 1 0 0 1 1 1v1a5 5 0 0 1-5 5H6.91l.800.79a1 1 0 1 1-1.42 1.42l-2.5-2.5a1 1 0 0 1 0-1.42l2.5-2.5a1 1 0 0 1 1.42 1.42L6.91 17H16a3 3 0 0 0 3-3v-1a1 1 0 0 1 1-1Z" />,
  repeatOne: (
    <>
      <path d="M16.29 2.79a1 1 0 0 1 1.42 0l2.5 2.5a1 1 0 0 1 0 1.42l-2.5 2.5a1 1 0 1 1-1.42-1.42L17.09 7H8a3 3 0 0 0-3 3v1a1 1 0 1 1-2 0v-1a5 5 0 0 1 5-5h9.09l-.800-.790a1 1 0 0 1 0-1.42ZM20 12a1 1 0 0 1 1 1v1a5 5 0 0 1-5 5H6.91l.800.79a1 1 0 1 1-1.42 1.42l-2.5-2.5a1 1 0 0 1 0-1.42l2.5-2.5a1 1 0 0 1 1.42 1.42L6.91 17H16a3 3 0 0 0 3-3v-1a1 1 0 0 1 1-1Z" />
      <path d="M11.3 9.6a.900.9 0 0 1 1.6.560v4.24a.900.9 0 1 1-1.8 0v-2.33l-.300.19a.900.9 0 0 1-.960-1.52l1.46-.940Z" />
    </>
  ),
  // Four corners pulling outward: the whole screen.
  expand: <path d="M4 5a1 1 0 0 1 1-1h4a1 1 0 1 1 0 2H6v3a1 1 0 1 1-2 0V5Zm10 0a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 1 1-2 0V6h-3a1 1 0 0 1-1-1ZM5 14a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Zm14 0a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 1 1 0-2h3v-3a1 1 0 0 1 1-1Z" />,
  // A window with a smaller one set in its corner.
  float: <path d="M5 4h14a2 2 0 0 1 2 2v5a1 1 0 1 1-2 0V6H5v12h4a1 1 0 1 1 0 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm8 9h7a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z" />,
  heart: <path d="M12 20.3 4.9 13.4a4.9 4.9 0 0 1 0-7 5 5 0 0 1 7.1 0 5 5 0 0 1 7.1 0 4.9 4.9 0 0 1 0 7L12 20.3Zm0-2.8 5.7-5.5a2.9 2.9 0 0 0 0-4.2 3 3 0 0 0-4.2 0L12 9.2l-1.5-1.4a3 3 0 0 0-4.2 0 2.9 2.9 0 0 0 0 4.2L12 17.5Z" />,
  heartOn: <path d="M12 20.3 4.9 13.4a4.9 4.9 0 0 1 0-7 5 5 0 0 1 7.1 0 5 5 0 0 1 7.1 0 4.9 4.9 0 0 1 0 7L12 20.3Z" />,
  // A screen with a triangle rising into it: where the sound can be sent.
  airplay: <path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-1.6l-1.7-2H19V6H5v9h3.3l-1.7 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm7 9.4 5.1 6.1a.3.3 0 0 1-.23.5H7.13a.3.3 0 0 1-.23-.5L12 13.4Z" />,
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
interface TransportBarProps {
  snap: Snapshot;
  onFindSong: () => void;
  /** Whether lyrics are on the screen, so there is something to put on the full screen. */
  lyricsShown: boolean;
  onFocus: () => void;
  /** Whether the lyrics are floating in a window of their own, and the way to float them or bring them back. */
  floating: boolean;
  onFloat: () => void;
}

export function TransportBar({ snap, onFindSong, lyricsShown, onFocus, floating, onFloat }: TransportBarProps) {
  const seekRef = useRef<HTMLInputElement>(null);
  const elapsedRef = useRef<HTMLOutputElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const now = nowPlaying(snap);

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

  const quality = snap.currentTrack ? qualityOf(snap.currentTrack) : '';
  const loved = snap.currentTrack?.nas ? (snap.favourites?.songs.some((song) => song.track.id === snap.currentTrack?.nas?.id) ?? false) : false;

  return (
    <footer className="bar">
      <div className="now-zone">
        {now?.art && <img className="art" src={now.art} alt="" />}
        <div className="now">
          <div className="now-title">
            {now?.link ? <a href={now.link} target="_blank" rel="noopener" title="Open in Apple Music">{now.title}</a> : now?.title}
            {now?.otherTitle && <span className="other-name"> ({now.otherTitle})</span>}
          </div>
          <div className="credit-line">
            <span className="credit">{credit}</span>
            {quality && !snap.casting && <span className="quality" title="How this song's audio is stored">{quality}</span>}
            {snap.casting && <span className="quality casting">on {snap.casting}</span>}
          </div>
        </div>
        {snap.favourites && snap.currentTrack?.nas && (
          <IconButton icon={loved ? 'heartOn' : 'heart'} label={loved ? 'Remove from favourites' : 'Add to favourites'} className="favourite" pressed={loved} onClick={() => void store.toggleFavouriteSong(snap.currentTrack!)} />
        )}
      </div>

      <div className="center-zone">
        <div className="transport">
          <IconButton icon="shuffle" label="Shuffle" pressed={snap.shuffle} onClick={() => store.toggleShuffle()} />
          <IconButton icon="previous" label="Previous" onClick={() => store.step(-1)} />
          <IconButton icon={snap.playing ? 'pause' : 'play'} label={snap.playing ? 'Pause' : 'Play'} className="play" onClick={() => store.toggle()} />
          <IconButton icon="next" label="Next" onClick={() => store.step(1)} disabled={!store.canGoNext()} />
          <IconButton
            icon={snap.repeat === 'one' ? 'repeatOne' : 'repeat'}
            label={snap.repeat === 'one' ? 'Repeat: this song' : snap.repeat === 'all' ? 'Repeat: all songs' : 'Repeat: off'}
            pressed={snap.repeat !== 'off'}
            onClick={() => store.cycleRepeat()}
          />
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
              {snap.song && snap.song.timed && !snap.song.wordTimed && (
                <label className="toggle" title="These lyrics only say when each line is sung. Sweeping fills a line evenly over its length.">
                  <input type="checkbox" checked={snap.sweepLines} onChange={(e) => store.setSweepLines(e.currentTarget.checked)} /> Sweep across each line
                </label>
              )}
              {snap.canSetVolume && (
                <label className="toggle" title="Songs whose files say how loud they are play at about the same loudness. An album played in order keeps its own quiet and loud songs.">
                  <input type="checkbox" checked={snap.levelVolume} onChange={(e) => store.setLevelVolume(e.currentTarget.checked)} /> Level the volume between songs
                </label>
              )}
              {!snap.canSetVolume && snap.canMix && (
                <>
                  <label className="toggle">
                    <input type="checkbox" checked={snap.mixing} onChange={(e) => void store.setMixing(e.currentTarget.checked)} /> Level the volume between songs
                  </label>
                  <p className="toggle-note">Songs whose files say how loud they are play at about the same loudness. While this is on, AirPlay can't carry the sound.</p>
                </>
              )}
              {snap.canGapless && (snap.canSetVolume || snap.mixing) && (
                <label className="toggle" title="The songs of an album follow each other with no gap at all, as they were made. For FLAC songs.">
                  <input type="checkbox" checked={snap.gapless} onChange={(e) => store.setGapless(e.currentTarget.checked)} /> Join an album's songs without a gap
                </label>
              )}
              {(snap.canSetVolume || snap.mixing) && (
                <label className="choice" title="One song fades into the next over this long. Songs of an album played in order follow each other as they were made, without a fade.">
                  Crossfade
                  <select value={snap.crossfade} onChange={(e) => store.setCrossfade(Number(e.currentTarget.value))}>
                    <option value={0}>Off</option>
                    {[2, 4, 6, 8, 12].map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}
                  </select>
                </label>
              )}
              {snap.song?.timed && (
                <label className="toggle" title="When this is off, pressing a line does nothing, so a stray touch can't move the song.">
                  <input type="checkbox" checked={snap.seekOnLine} onChange={(e) => store.setSeekOnLine(e.currentTarget.checked)} /> Press a line to go to it
                </label>
              )}
              {snap.song?.timed && (
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
              <button className="plain-button" type="button" onClick={() => { setOptionsOpen(false); onFindSong(); }}>Find this song in Apple Music</button>
              {snap.canCast && snap.pairing && (
                <button className="plain-button" type="button" onClick={() => { setOptionsOpen(false); void (snap.casting ? store.stopCast() : store.startCast()); }}>
                  {snap.casting ? `Stop casting to ${snap.casting}` : 'Cast to a speaker or TV'}
                </button>
              )}
              {lyricsShown && (
                <div className="extras-narrow">
                  <button className="plain-button" type="button" onClick={() => { setOptionsOpen(false); onFocus(); }}>Lyrics on the full screen</button>
                </div>
              )}
              {snap.canAirplay && !snap.mixing && (
                <div className="extras-airplay">
                  <button className="plain-button" type="button" onClick={() => { setOptionsOpen(false); store.chooseAirplay(); }}>Play on an AirPlay speaker</button>
                </div>
              )}
              {volume && <div className="extras-volume">{volume}</div>}
            </div>
          )}
        </div>
        {lyricsShown && <IconButton icon="expand" label="Lyrics on the full screen" className="wide-only" onClick={onFocus} />}
        {canFloat() && snap.song && <IconButton icon="float" label={floating ? 'Close the floating lyrics' : 'Float the lyrics in a window'} className="wide-only" pressed={floating} onClick={onFloat} />}
        {snap.canAirplay && !snap.mixing && <IconButton icon="airplay" label="AirPlay" className="airplay" onClick={() => store.chooseAirplay()} />}
        <IconButton icon="songs" label="Songs" pressed={snap.songsOpen} onClick={() => (snap.songsOpen ? store.closeSongs() : store.openSongs())} />
        {volume}
      </div>
    </footer>
  );
}
