import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Snapshot } from '../player/store';
import { LyricsView } from './LyricsView';
import { nowPlaying } from './format';

/** The browser's way of opening a small window that stays above the others (Chrome and Edge on a computer). */
interface PictureInPicture {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}
const pictureInPicture = (): PictureInPicture | undefined => (window as unknown as { documentPictureInPicture?: PictureInPicture }).documentPictureInPicture;

/** Whether this browser can float the lyrics in a window of their own. */
export const canFloat = (): boolean => pictureInPicture() !== undefined;

/**
 * Opens the floating window and gives it the page's styles and fonts. Must be called from a click. Null when the
 * browser refuses.
 */
export async function openFloatingWindow(): Promise<Window | null> {
  try {
    const win = await pictureInPicture()!.requestWindow({ width: 420, height: 520 });
    const head = win.document.head;
    // Addresses in the styles (the fonts) are written from the page's own address, not the empty window's.
    const base = win.document.createElement('base');
    base.href = `${location.origin}/`;
    head.append(base);
    for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) {
      const copy = node.cloneNode(true) as HTMLElement;
      if (copy instanceof HTMLLinkElement) copy.href = (node as HTMLLinkElement).href;
      head.append(copy);
    }
    win.document.documentElement.lang = document.documentElement.lang;
    win.document.title = 'Taiko lyrics';
    return win;
  } catch {
    return null;
  }
}

/** The lyrics in the floating window: the song's name, then the same lyrics, following the song there too. */
export function FloatingLyrics({ snap, win, onClosed }: { snap: Snapshot; win: Window; onClosed: () => void }) {
  useEffect(() => {
    win.addEventListener('pagehide', onClosed);
    return () => win.removeEventListener('pagehide', onClosed);
  }, [win, onClosed]);
  // The window shows what the page's switches say: romanization and translation on or off.
  useEffect(() => {
    win.document.body.className = ['floating', !snap.showRoman && 'no-roman', !snap.showTranslation && 'no-translation'].filter(Boolean).join(' ');
  }, [win, snap.showRoman, snap.showTranslation]);

  const now = nowPlaying(snap);
  return createPortal(
    <>
      <header className="floating-head">
        <span className="floating-title">{now?.title ?? 'Nothing is playing'}</span>
        {now?.artist && <span className="floating-artist">{now.artist}</span>}
      </header>
      {snap.song
        ? <LyricsView song={snap.song} />
        : <p className="floating-note">{snap.lyricsLoading ? 'Loading lyrics' : snap.currentTrack ? 'This song has no lyrics yet.' : 'Choose a song in Taiko and its lyrics show here.'}</p>}
    </>,
    win.document.body,
  );
}
