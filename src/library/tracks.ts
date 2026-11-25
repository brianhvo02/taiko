/**
 * Tracks, wherever they come from. A device track is a file the person picked (read in place, never uploaded);
 * a NAS track is streamed from a paired server. Either kind can have lyrics files from the device attached.
 */
import { AUDIO_EXTENSIONS, LYRICS_EXTENSIONS, lyricsBelongTo } from '../shared/api';
import type { NasTrack } from '../shared/api';
import { TAG_HEAD_BYTES, readTags } from '../shared/tags';

export interface Track {
  id: string;
  origin: 'device' | 'nas';
  title: string;
  artist: string;
  album: string;
  trackNumber: number | null;
  discNumber: number | null;
  durationSeconds: number | null;
  /** The audio file's name, used to match lyrics files to it. */
  fileName: string;
  /** Set for a device track. */
  file: File | null;
  /** Set for a NAS track. */
  nas: NasTrack | null;
  /** Lyrics files picked on this device for this track. */
  lyricFiles: File[];
}

const extension = (name: string) => (/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase();
const withoutExtension = (name: string) => name.replace(/\.[^.]+$/, '');

export const isAudio = (file: File): boolean =>
  file.type.startsWith('audio/') || (AUDIO_EXTENSIONS as readonly string[]).includes(extension(file.name));
export const isLyrics = (file: File): boolean =>
  (LYRICS_EXTENSIONS as readonly string[]).includes(extension(file.name)) || ['xml', 'txt'].includes(extension(file.name));

let nextDeviceId = 1;

async function trackFromFile(file: File): Promise<Track> {
  let tags = { title: '', artist: '', album: '', trackNumber: null as number | null, discNumber: null as number | null, durationSeconds: null as number | null };
  try {
    tags = readTags(new Uint8Array(await file.slice(0, TAG_HEAD_BYTES).arrayBuffer()));
  } catch {
    // An unreadable start of file leaves the name as the title.
  }
  return {
    id: `device:${nextDeviceId++}`,
    origin: 'device',
    ...tags,
    title: tags.title || withoutExtension(file.name),
    fileName: file.name,
    file,
    nas: null,
    lyricFiles: [],
  };
}

export function trackFromNas(nas: NasTrack): Track {
  return {
    id: `nas:${nas.id}`,
    origin: 'nas',
    title: nas.title,
    artist: nas.artist,
    album: nas.album,
    trackNumber: nas.trackNumber,
    discNumber: nas.discNumber,
    durationSeconds: nas.durationSeconds,
    fileName: '',
    file: null,
    nas,
    lyricFiles: [],
  };
}

export interface Sorted {
  /** New tracks, in album order, each with the batch's lyrics files that match its name. */
  tracks: Track[];
  /** Lyrics files that matched no audio file in the batch. */
  looseLyrics: File[];
  /** Names of files that are neither audio nor lyrics. */
  skipped: string[];
}

const order = (a: Track, b: Track) =>
  a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) || (a.discNumber ?? 0) - (b.discNumber ?? 0) ||
  (a.trackNumber ?? 0) - (b.trackNumber ?? 0) || a.title.localeCompare(b.title);

/** Sorts a batch of picked files into tracks and lyrics. */
export async function sortFiles(files: File[]): Promise<Sorted> {
  const audio = files.filter(isAudio);
  const lyrics = files.filter((file) => !isAudio(file) && isLyrics(file));
  const skipped = files.filter((file) => !isAudio(file) && !isLyrics(file)).map((file) => file.name);
  const tracks = (await Promise.all(audio.map(trackFromFile))).sort(order);
  const looseLyrics: File[] = [];
  for (const file of lyrics) {
    // When two songs match by name (Kite.flac and Kite_live.flac with Kite_live.lrc), the longer name wins, as on the NAS.
    const owner = tracks.filter((track) => lyricsBelongTo(file.name, track.fileName)).sort((x, y) => y.fileName.length - x.fileName.length)[0];
    if (owner) owner.lyricFiles.push(file);
    else looseLyrics.push(file);
  }
  return { tracks, looseLyrics, skipped };
}
