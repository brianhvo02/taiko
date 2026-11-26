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
    // The window the lyrics are shown in: the page's own, or the small floating one (see FloatingLyrics.tsx),
    // whose frames keep coming when the page itself is in the background.
    const win = root.ownerDocument.defaultView ?? window;
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
          if (!store.getSnapshot().seekOnLine || !song.timed) return;
          store.seek(line.begin + store.getSnapshot().offset);
          holdUntil = 0;
        });
        holder.append(el);
        lines.push({ begin: line.begin, end: line.end, el, state: 'future', words });
      }
      section.append(holder);
      root.append(section);
    }

    // Lyrics with no timing are simply there to read: every line lit, none of them a button, nothing following the song.
    if (!song.timed) {
      root.classList.add('still', 'untimed');
      for (const line of lines) {
        line.el.dataset.state = 'active';
        line.el.tabIndex = -1;
        line.el.setAttribute('aria-disabled', 'true');
        for (const word of line.words) word.el.style.setProperty('--p', '1');
      }
      win.scrollTo(0, 0);
      return () => root.classList.remove('still', 'untimed');
    }

    const reducedMotion = win.matchMedia('(prefers-reduced-motion: reduce)');
    // On a phone the line being sung sits at the top, where the styles leave room for it; on a wide screen, in the middle.
    const narrow = win.matchMedia('(max-width: 44rem)');
    let shown = -1;
    // Whether a press on a line moves the song there. When it doesn't, the lines stop looking and acting like buttons.
    let pressable = true;
    let holdUntil = 0;
    let frame = 0;
    // Following the song pauses for a moment when the listener scrolls by hand.
    const hold = () => { holdUntil = performance.now() + 4000; };
    const onKey = (e: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key)) hold();
    };
    let seeks = store.seekCount;
    win.addEventListener('wheel', hold, { passive: true });
    win.addEventListener('touchmove', hold, { passive: true });
    win.addEventListener('keydown', onKey);

    const tick = () => {
      const settings = store.getSnapshot();
      const t = store.position() - settings.offset;
      // Word by word when the words are timed, or when the listener asked for line-timed lyrics to be swept too.
      const sweep = song.wordTimed || settings.sweepLines;
      if (settings.seekOnLine !== pressable) {
        pressable = settings.seekOnLine;
        root.classList.toggle('still', !pressable);
        for (const line of lines) {
          line.el.tabIndex = pressable ? 0 : -1;
          line.el.setAttribute('aria-disabled', String(!pressable));
        }
      }
      // A seek means the listener wants to be where the song is: follow it again.
      if (store.seekCount !== seeks) { seeks = store.seekCount; holdUntil = 0; }
      let current = -1;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const state = t < line.begin ? 'future' : t >= line.end ? 'past' : 'active';
        if (state !== line.state) { line.state = state; line.el.dataset.state = state; }
        if (t >= line.begin && (current < 0 || line.begin >= lines[current].begin)) current = i;
        for (const word of line.words) {
          // Without word timings a line lights up whole as it starts; sweeping across it shows timing the file doesn't have.
          const p = !sweep ? (t >= word.begin ? 1 : 0)
            : t <= word.begin ? 0 : t >= word.end ? 1 : (t - word.begin) / (word.end - word.begin);
          if (p !== word.p) { word.p = p; word.el.style.setProperty('--p', p.toFixed(3)); }
        }
      }
      if (current !== shown) {
        shown = current;
        if (current >= 0 && performance.now() >= holdUntil) {
          lines[current].el.scrollIntoView({ block: narrow.matches ? 'start' : 'center',behavior: reducedMotion.matches ? 'auto' : 'smooth' });
        }
      }
      frame = win.requestAnimationFrame(tick);
    };
    win.scrollTo(0, 0);
    frame = win.requestAnimationFrame(tick);

    return () => {
      win.cancelAnimationFrame(frame);
      win.removeEventListener('wheel', hold);
      win.removeEventListener('touchmove', hold);
      win.removeEventListener('keydown', onKey);
    };
  }, [song]);

  return <div className="lyrics" ref={ref} />;
}
