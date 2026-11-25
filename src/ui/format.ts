import type { Snapshot } from '../player/store';
import { smallCover } from '../library/tracks';
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

/** How a song's audio is stored, as a listener reads it: "24-bit 96 kHz". Empty when it isn't known. */
export function qualityOf(song: { sampleRate?: number; bitsPerSample?: number }): string {
  if (!song.sampleRate || !song.bitsPerSample) return '';
  return `${song.bitsPerSample}-bit ${Number((song.sampleRate / 1000).toFixed(2))} kHz`;
}

/** Whether a name is written in a script that a reading in Latin letters helps with (Japanese, say). */
export const needsReading = (name: string): boolean => /[^\u0000-\u024f\u2000-\u206f]/.test(name);

/**
 * The other forms of a name worth showing beside it: its reading, when the name isn't in Latin script, and its
 * English form, each only when it says something the name (or the form before it) doesn't.
 */
export function otherForms(name: string, reading?: string, english?: string): string {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const forms: string[] = [];
  if (reading && needsReading(name) && !same(reading, name)) forms.push(reading);
  if (english && !same(english, name) && !forms.some((form) => same(form, english))) forms.push(english);
  return forms.join(', ');
}

/** What to call the open song: Apple's catalog names when it was identified, the file's tags otherwise. */
export function nowPlaying(snap: Snapshot): NowPlaying | null {
  const track = snap.currentTrack;
  if (!track) return null;
  const { songInfo, usInfo } = snap;
  // The album's own cover on the NAS comes before Apple's.
  const art = track.cover ? smallCover(track.cover) : songInfo?.artworkUrl100 ?? '';
  // A file that carries its own other names (a reading, an English name) is named by them, not by the catalog.
  if (track.titleRoman || track.titleEnglish || track.artistRoman || track.artistEnglish || !songInfo) {
    return {
      title: track.title,
      otherTitle: otherForms(track.title, track.titleRoman, track.titleEnglish),
      artist: track.artist,
      otherArtist: otherForms(track.artist, track.artistRoman, track.artistEnglish),
      link: songInfo?.trackViewUrl ?? '',
      art,
    };
  }
  return {
    title: songInfo.trackName,
    otherTitle: usInfo && usInfo.trackName !== songInfo.trackName ? usInfo.trackName : '',
    artist: songInfo.artistName,
    otherArtist: usInfo && usInfo.artistName !== songInfo.artistName ? usInfo.artistName : '',
    link: songInfo.trackViewUrl ?? '',
    art,
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
