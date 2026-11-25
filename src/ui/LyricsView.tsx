import { useEffect, useRef } from 'react';
import type { Piece, Song } from '../lyrics/ttml';
import { store } from '../player/store';

interface TimedWord {
  begin: number;
  end: number;
  el: HTMLElement;
  p: number;
}

interface ShownLine {
  begin: number;
  end: number;
  el: HTMLButtonElement;
  state: string;
  words: TimedWord[];
}

function row(className: string, pieces: Piece[], words: TimedWord[], language: string): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  if (language) el.lang = language;
  for (const piece of pieces) {
    if (piece.kind === 'space') { el.append(' '); continue; }
    const word = document.createElement('span');
    word.className = 'w';
    word.textContent = piece.text;
    el.append(word);
    words.push({ begin: piece.begin, end: piece.end, el: word, p: 0 });
  }
  return el;
}

/**
 * The lyrics, filled word by word against the audio clock. The lines are built and updated by hand, outside
 * React's rendering: every word's fill changes each frame, and only this component touches these nodes.
 */
export function LyricsView({ song }: { song: Song }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const lines: ShownLine[] = [];
    root.replaceChildren();

    for (const part of song.parts) {
      const section = document.createElement('section');
      section.className = 'part';
      if (part.name) {
        const name = document.createElement('div');
        name.className = 'part-name';
        name.textContent = part.name;
        section.append(name);
      }
      const holder = document.createElement('div');
      holder.className = 'lines';
      for (const line of part.lines) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'line';
        el.dataset.state = 'future';
        const words: TimedWord[] = [];
        el.append(row('original', line.original, words, song.language));
        if (line.roman) el.append(row('roman', line.roman, words, ''));
        if (line.translation) {
          const sentence = document.createElement('span');
          sentence.className = 'translation';
          sentence.textContent = line.translation;
          if (song.translationLanguage) sentence.lang = song.translationLanguage;
          el.append(sentence);
        }
        el.addEventListener('click', () => {
          store.seek(line.begin + store.getSnapshot().offset);
          holdUntil = 0;
        });
        holder.append(el);
        lines.push({ begin: line.begin, end: line.end, el, state: 'future', words });
      }
      section.append(holder);
      root.append(section);
    }

    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    let shown = -1;
    let holdUntil = 0;
    let frame = 0;
    // Following the song pauses for a moment when the listener scrolls by hand.
    const hold = () => { holdUntil = performance.now() + 4000; };
    const onKey = (e: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key)) hold();
    };
    let seeks = store.seekCount;
    addEventListener('wheel', hold, { passive: true });
    addEventListener('touchmove', hold, { passive: true });
    addEventListener('keydown', onKey);

    const tick = () => {
      const t = store.position() - store.getSnapshot().offset;
      // A seek means the listener wants to be where the song is: follow it again.
      if (store.seekCount !== seeks) { seeks = store.seekCount; holdUntil = 0; }
      let current = -1;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const state = t < line.begin ? 'future' : t >= line.end ? 'past' : 'active';
        if (state !== line.state) { line.state = state; line.el.dataset.state = state; }
        if (t >= line.begin && (current < 0 || line.begin >= lines[current].begin)) current = i;
        for (const word of line.words) {
          const p = t <= word.begin ? 0 : t >= word.end ? 1 : (t - word.begin) / (word.end - word.begin);
          if (p !== word.p) { word.p = p; word.el.style.setProperty('--p', p.toFixed(3)); }
        }
      }
      if (current !== shown) {
        shown = current;
        if (current >= 0 && performance.now() >= holdUntil) {
          lines[current].el.scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
        }
      }
      frame = requestAnimationFrame(tick);
    };
    scrollTo(0, 0);
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      removeEventListener('wheel', hold);
      removeEventListener('touchmove', hold);
      removeEventListener('keydown', onKey);
    };
  }, [song]);

  return <div className="lyrics" ref={ref} />;
}
