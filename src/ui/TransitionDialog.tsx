import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Snapshot } from '../player/store';
import { store } from '../player/store';
import { MAX_TRANSITION_SECONDS, transitionKey } from '../shared/playlists';
import type { SavedTrack, Transition } from '../shared/playlists';

type Kind = 'usual' | 'cut' | 'fade';

/** The most a song can be left early, or the next one started late, with the sliders. */
const MAX_TRIM = 60;

/**
 * A drawing of the join: the first song ending, the next beginning, and where they overlap. What is skipped (an
 * outro left early, an intro passed over) is drawn as an outline. Five seconds to the tick.
 */
function JoinPicture({ fade, leave, startAt }: { fade: number; leave: number; startAt: number }) {
  const scale = 3.2;
  const join = 150;
  const top = 8;
  const height = 26;
  const gap = 8;
  const fadeWidth = fade * scale;
  const second = top + height + gap;
  return (
    <svg className="join-picture" viewBox="0 0 320 84" role="img" aria-label={`${fade ? `A ${fade} second crossfade` : 'No fade'}${leave ? `, leaving the first song ${leave} seconds early` : ''}${startAt ? `, starting the next ${startAt} seconds in` : ''}`}>
      {/* The first song: full until the fade, then falling away. What it had left is an outline. */}
      <path className="join-first" d={`M0 ${top} H${join - fadeWidth} L${join} ${top + height} H0 Z`} />
      {leave > 0 && <rect className="join-skipped" x={join} y={top} width={Math.min(leave * scale, 320 - join)} height={height} />}
      {/* The next song: rising through the fade, then full. What was passed over is an outline before it. */}
      <path className="join-next" d={`M${join - fadeWidth} ${second + height} L${join} ${second} H320 V${second + height} Z`} />
      {startAt > 0 && <rect className="join-skipped" x={Math.max(0, join - fadeWidth - startAt * scale)} y={second} width={Math.min(startAt * scale, join - fadeWidth)} height={height} />}
      <line className="join-mark" x1={join} x2={join} y1={2} y2={82} />
    </svg>
  );
}

/** Shapes the join between a song of a playlist and the one after it, with a way to hear it before it is kept. */
export function TransitionDialog({ snap, id, from, to, index, onClose }: { snap: Snapshot; id: string; from: SavedTrack; to: SavedTrack; index: number; onClose: () => void }) {
  const kept = snap.playlists.find((playlist) => playlist.id === id)?.transitions?.[transitionKey(from.id, to.id)] ?? null;
  const [kind, setKind] = useState<Kind>(kept?.kind ?? 'usual');
  const [seconds, setSeconds] = useState(kept?.kind === 'fade' ? kept.seconds : snap.crossfade || 6);
  const [leave, setLeave] = useState(kept?.leave ?? 0);
  const [startAt, setStartAt] = useState(kept?.startAt ?? 0);
  const canFade = snap.canSetVolume || snap.mixing;
  const shaped: Transition | null = kind === 'usual' ? null : { kind, seconds: kind === 'fade' ? seconds : 0, leave, startAt };
  // What is drawn: the join as it will play, the usual one included.
  const drawn = shaped ?? { kind: snap.crossfade ? 'fade' as const : 'cut' as const, seconds: snap.crossfade, leave: 0, startAt: 0 };

  // Leaving the dialog, however it is left, ends the trying-out.
  useEffect(() => () => store.stopTrying(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  const slider = (label: string, value: number, max: number, set: (value: number) => void, said: string) => (
    <label className="trim">
      <span>{label}</span>
      <input type="range" min={0} max={max} step={1} value={value} disabled={kind === 'usual'} style={{ '--fill': `${(value / max) * 100}%` } as CSSProperties} onChange={(e) => set(Number(e.currentTarget.value))} />
      <output>{said}</output>
    </label>
  );

  return (
    <div className="scrim">
      <form className="dialog join" role="dialog" aria-modal="true" aria-labelledby="join-title" onSubmit={(e) => { e.preventDefault(); store.setTransition(id, from.id, to.id, shaped); onClose(); }}>
        <h2 id="join-title">From {from.title} into {to.title}</h2>
        <JoinPicture fade={drawn.kind === 'fade' && canFade ? drawn.seconds : 0} leave={drawn.leave} startAt={drawn.startAt} />
        <label className="choice">
          The join
          <select value={kind} onChange={(e) => setKind(e.currentTarget.value as Kind)}>
            <option value="usual">As set under Options</option>
            <option value="cut">No fade</option>
            <option value="fade">Crossfade</option>
          </select>
        </label>
        {kind === 'fade' && (
          <label className="trim">
            <span>Crossfade for</span>
            <input type="range" min={1} max={MAX_TRANSITION_SECONDS} step={1} value={seconds} style={{ '--fill': `${((seconds - 1) / (MAX_TRANSITION_SECONDS - 1)) * 100}%` } as CSSProperties} onChange={(e) => setSeconds(Number(e.currentTarget.value))} />
            <output>{seconds} s</output>
          </label>
        )}
        {slider(`Leave ${from.title}`, leave, MAX_TRIM, setLeave, leave ? `${leave} s early` : 'at its end')}
        {slider(`Start ${to.title}`, startAt, MAX_TRIM, setStartAt, startAt ? `${startAt} s in` : 'at its start')}
        {kind === 'fade' && !canFade && <p className="notice">A fade needs "Level the volume between songs" turned on, under Options. Until then this join plays without one.</p>}
        <p>This is for this playlist played in order. "Hear it" plays from a few seconds before the join.</p>
        <div className="actions">
          <button className="plain-button" type="button" onClick={() => void store.tryTransition(id, index, shaped)}>Hear it</button>
          <button className="plain-button primary-button" type="submit">{kind === 'usual' && kept ? 'Put it back to the usual' : 'Save'}</button>
          <button className="plain-button" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
