import type { Snapshot } from '../player/store';
import { AUDIO_EXTENSIONS } from '../shared/api';

/** Seconds as m:ss. */
export function formatTime(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export interface NowPlaying {
  title: string;
  /** The US catalog's title when it differs from the home storefront's, else ''. */
  otherTitle: string;
  artist: string;
  otherArtist: string;
  link: string;
  art: string;
}

/** What to call the open song: Apple's catalog names when it was identified, the file's tags otherwise. */
export function nowPlaying(snap: Snapshot): NowPlaying | null {
  const track = snap.currentTrack;
  if (!track) return null;
  const { songInfo, usInfo } = snap;
  if (!songInfo) return { title: track.title, otherTitle: '', artist: track.artist, otherArtist: '', link: '', art: '' };
  return {
    title: songInfo.trackName,
    otherTitle: usInfo && usInfo.trackName !== songInfo.trackName ? usInfo.trackName : '',
    artist: songInfo.artistName,
    otherArtist: usInfo && usInfo.artistName !== songInfo.artistName ? usInfo.artistName : '',
    link: songInfo.trackViewUrl ?? '',
    art: songInfo.artworkUrl100 ?? '',
  };
}

const ACCEPT = ['audio/*', ...AUDIO_EXTENSIONS.map((ext) => `.${ext}`), '.json', '.ttml', '.lrc', '.xml'].join(',');

/** Opens the system file picker. Call it from a click. Resolves with nothing when the person cancels. */
export function pickFiles(folder = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (folder) input.setAttribute('webkitdirectory', '');
    else input.accept = ACCEPT;
    // The input sits in the page while the dialog is open: a browser may drop one that isn't attached to anything
    // before it reports what was picked (Firefox does).
    input.hidden = true;
    document.body.append(input);
    let cancelled = 0;
    const done = (files: File[]) => {
      clearTimeout(cancelled);
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])), { once: true });
    // A cancel is believed only if no files follow it: a browser driven by a test reports the dialog closing
    // just before it hands over the files.
    input.addEventListener('cancel', () => { cancelled = window.setTimeout(() => done([]), 500); }, { once: true });
    input.click();
  });
}

/** Whether this browser can pick a whole folder (phones generally can't). */
export const canPickFolder = (): boolean => 'webkitdirectory' in document.createElement('input');
