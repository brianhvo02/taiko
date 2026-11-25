/**
 * The player's state, as an external store the UI reads with `useSyncExternalStore` (no state library). It owns
 * the one `<audio>` element. Time-driven display (the lyric fill, the seek bar) reads `store.audio.currentTime`
 * each animation frame instead of going through snapshots.
 */
import { counterpart, identify } from '../apple/catalog';
import type { AppleSong, Identified } from '../apple/catalog';
import { sortFiles, trackFromNas } from '../library/tracks';
import type { Track } from '../library/tracks';
import { mergeInto, sameSong, serialize } from '../lyrics/merge';
import { openLyrics, songFromDoc } from '../lyrics/ttml';
import type { LyricsSource, Song } from '../lyrics/ttml';
import {
  NasError, clearPairing, fetchFolder, fetchLibrary, fetchLyrics, fetchTicket, forget, loadLastPath, loadPairing, pair, parsePairLink, saveLastPath, searchLibrary, startScan,
} from '../nas/client';
import type { PairLink, Pairing } from '../nas/client';
import { lyricsBelongTo, pathOfTrackId, trackIdOf } from '../shared/api';
import {
  cleanName, loadOffsets, loadPlaylists, loadSession, loadSettings, saveOffset, savePlaylists, saveSession, saveSettings, withMoved, withTracks, withoutTrack,
} from './persist';
import type { Playlist, QueueSource, SavedTrack, Session } from './persist';
import { makeOrder, nextRepeat, stepFrom } from './queue';
import type { Repeat } from './queue';
import { folderOf, parseRoute, routeUrl } from './route';
import type { Route } from './route';
import { flacStartAt, readFlacIndex, streamHeader } from '../shared/flac';
import type { FlacIndex, Reader } from '../shared/flac';
import type { NasAlbum, NasFolder } from '../shared/api';

/** One folder of the paired NAS, as the browser shows it. */
export interface NasListing {
  /** '' for the list of roots. */
  path: string;
  parent: string | null;
  folders: NasFolder[];
  tracks: Track[];
  /** The address of the folder's cover picture, when it has one. */
  cover: string | null;
}

export type SongsTab = 'folders' | 'playlists' | 'device';

/** What the library is showing: its front page, an artist, an album on the NAS, or an album of this device's songs. */
export type LibraryPage = { kind: 'home' } | { kind: 'artist'; name: string } | { kind: 'album'; path: string } | { kind: 'deviceAlbum'; name: string };

/** The NAS's album library. 'off' when the NAS keeps none (only its folders can be browsed). */
export interface LibraryState {
  state: 'idle' | 'loading' | 'ready' | 'off' | 'error';
  albums: NasAlbum[];
  scanning: boolean;
}

/** The songs of the NAS album that is open in the library. */
export interface AlbumView {
  path: string;
  state: 'loading' | 'ready' | 'missing';
  tracks: Track[];
  cover: string | null;
}

export interface Snapshot {
  /** The songs picked on this device. */
  tracks: Track[];
  /** The list the open song plays from (the device's songs, or one NAS folder). Back and Next walk it. */
  queue: Track[];
  currentId: string | null;
  currentTrack: Track | null;
  /** The current track's lyrics, or null when it has none (or they are still loading). */
  song: Song | null;
  lyricsLoading: boolean;
  /** The lyrics files the current song's lyrics were combined from. */
  lyricsNames: string[];
  songInfo: AppleSong | null;
  usInfo: AppleSong | null;
  playing: boolean;
  duration: number;
  /** Seconds the lyrics are shifted; positive shows them later. */
  offset: number;
  showRoman: boolean;
  showTranslation: boolean;
  notice: string;
  pairing: Pairing | null;
  nasState: 'idle' | 'loading' | 'ready' | 'error';
  /** The NAS folder the browser is showing. */
  nasFolder: NasListing | null;
  /** Which of the two main views shows: the library, or the open song's lyrics. */
  view: 'library' | 'lyrics';
  page: LibraryPage;
  library: LibraryState;
  album: AlbumView | null;
  /** What is typed in the library's search, and the NAS songs found for it. */
  libraryQuery: string;
  searchTracks: Track[];
  /** Whether the Songs panel is open. */
  songsOpen: boolean;
  /** Which of the panel's lists is showing. */
  songsTab: SongsTab;
  /** Where the queue came from: this device's songs, a NAS folder, or a playlist. */
  source: QueueSource;
  repeat: Repeat;
  shuffle: boolean;
  /** Whether lyrics timed only by line are swept across like word-timed ones (see `Settings`). */
  sweepLines: boolean;
  /** This NAS's playlists, kept in the browser. */
  playlists: Playlist[];
  /** The playlist open in the panel, or null for the list of them. */
  openPlaylist: string | null;
  /** Where the listener was last time, offered on the first screen. */
  resume: Session | null;
  /** From 0 to 1. */
  volume: number;
  muted: boolean;
  /** False where only the device's own buttons set the volume (an iPhone): the slider is left out there. */
  canSetVolume: boolean;
  /** An invite link waiting for the person to confirm it. */
  pendingPair: PairLink | null;
  pairError: string;
}

const NAS_MESSAGES: Record<string, string> = {
  'bad-code': "That code didn't work. Ask the NAS owner for a new invite.",
  'too-many-attempts': 'Too many tries. Wait a few minutes, then try again.',
  unreachable: "Can't reach the NAS. If the browser asked about local network access, allow it. Otherwise check the address and that this device is on the NAS's network.",
};

/** The pairing the page started with. */
const START_PAIRING = loadPairing();

class PlayerStore {
  readonly audio = new Audio();
  private snapshot: Snapshot = {
    tracks: [], queue: [], currentId: null, currentTrack: null, song: null, lyricsLoading: false, lyricsNames: [], songInfo: null, usInfo: null,
    playing: false, duration: 0, offset: 0, ...loadSettings(), notice: '',
    view: 'library', page: { kind: 'home' }, library: { state: 'idle', albums: [], scanning: false }, album: null, libraryQuery: '', searchTracks: [],
    pairing: START_PAIRING, nasState: 'idle', nasFolder: null, songsOpen: false, songsTab: START_PAIRING ? 'folders' : 'device', source: { kind: 'device' },
    playlists: START_PAIRING ? loadPlaylists(START_PAIRING.base) : [], openPlaylist: null, resume: null, volume: loadVolume(), muted: false, canSetVolume: volumeCanBeSet(), pendingPair: null, pairError: '',
  };
  private listeners = new Set<() => void>();
  private source: LyricsSource | null = null;
  private urls = new Map<string, string>();
  private identified = new Map<string, Identified>();
  /** Lyrics picked before any audio; they go to the next track added. */
  private waitingLyrics: File[] = [];
  private loadRun = 0;
  private browseRun = 0;
  private albumRun = 0;
  private libraryTimer = 0;
  private searchTimer = 0;
  /** The queue positions in the order they play (queue.ts): as listed, or shuffled. */
  private order: number[] = [];
  /** Each song's lyric timing nudge, kept between visits. */
  private offsets = loadOffsets();

  // Exact seeking (src/shared/flac.ts). A FLAC track is never seeked by the browser: each seek plays a new stream
  // that begins at a frame, so the position is the stream's start plus how long it has played.
  /** Set when the open track can restart at an exact time: a FLAC file here (with its index) or on the NAS. */
  private exact: { index: FlacIndex | null; total: number } | null = null;
  /** The time the stream now playing begins at. */
  private streamStart = 0;
  /**
   * Whether the stream now playing reports the song's time instead of its own. A stream cut from the middle keeps
   * the song's frame numbers, and some browsers (Chrome) read their clock from those: a stream that begins at 60 s
   * then says 60, where others say 0.
   */
  private clockIsAbsolute = false;
  private clockChecked = false;
  /** What this browser did the last time it was clear, for a stream that begins too near 0 to tell. */
  private browserClockIsAbsolute: boolean | null = null;
  /** The time asked for, shown until the stream that starts there is ready. */
  private pendingSeek: number | null = null;
  private seekTimer = 0;
  private seekRun = 0;
  private restarting = false;
  /** The song played to its end. The element's own `ended` can't be trusted for a stream cut by an exact seek. */
  private finished = false;
  private resumeAfterSeek = false;
  /** The object URL of the cut stream now playing, for a file on this device. */
  private cutUrl = '';
  /** Goes up on every seek, so the lyrics know to follow the song again. */
  seekCount = 0;

  constructor() {
    this.audio.preload = 'auto';
    this.audio.volume = this.snapshot.volume;
    this.audio.addEventListener('play', () => this.set({ playing: true }));
    // Loading a restarted stream pauses the element for a moment; that isn't the listener pausing.
    this.audio.addEventListener('pause', () => {
      if (this.restarting) return;
      this.set({ playing: false });
      // A stream cut by an exact seek can stop at its end without the browser ever saying it ended (Chrome, whose
      // clock for such a stream doesn't line up with its length). Stopping at the song's end is the end.
      if (this.exact && this.position() >= this.exact.total - 0.3) this.songEnded();
    });
    this.audio.addEventListener('durationchange', () => {
      // A restarted stream reports only what remains; an exact-seek track's length comes from its index.
      if (!this.exact && Number.isFinite(this.audio.duration)) this.set({ duration: this.audio.duration });
    });
    this.audio.addEventListener('timeupdate', () => {
      // A second look at the clock, at the first time reported while playing, in case the browser only shows the
      // song's time once it plays. Only where a stream's own time couldn't have got that far yet.
      if (this.clockChecked || this.audio.currentTime <= 0) return;
      this.clockChecked = true;
      if (!this.clockIsAbsolute && this.streamStart > 1 && this.audio.currentTime >= this.streamStart - 0.25) {
        this.clockIsAbsolute = true;
        this.browserClockIsAbsolute = true;
      }
    });
    this.audio.addEventListener('playing', () => { this.finished = false; });
    this.audio.addEventListener('ended', () => this.songEnded());
    this.audio.addEventListener('error', () => {
      const track = this.current();
      if (track && this.audio.src) this.set({ notice: `This browser can't play ${track.fileName || track.title}.` });
    });

    const link = parsePairLink(location.hash);
    if (link) {
      history.replaceState(null, '', location.pathname + location.search);
      this.set({ pendingPair: link });
    }
    // The address bar says where to start: a NAS folder or song from a link, else the first screen.
    addEventListener('popstate', () => void this.applyRoute(parseRoute(location.pathname, location.search)));
    const route = parseRoute(location.pathname, location.search);
    if (route.kind !== 'home') void this.applyRoute(route);
    else {
      this.offerResume();
      if (this.snapshot.pairing) void this.openFolder(loadLastPath());
    }
    if (this.snapshot.pairing) void this.loadLibrary();
    // Where the listener is gets saved as they go, and when the page is put away.
    setInterval(() => { if (!this.audio.paused) this.saveSessionNow(); }, 5000);
    this.audio.addEventListener('pause', () => this.saveSessionNow());
    addEventListener('pagehide', () => this.saveSessionNow());
    this.wireMediaSession();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  private set(patch: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private current(): Track | null {
    return this.snapshot.currentTrack;
  }

  /** The song played to its end: go on to the next in the list, or stop after the last. Runs once per ending. */
  private songEnded(): void {
    if (this.finished) return;
    this.finished = true;
    const { queue, currentId, repeat } = this.snapshot;
    const at = queue.findIndex((track) => track.id === currentId);
    if (repeat === 'one') {
      // The same song again, from its start.
      this.resumeAfterSeek = true;
      this.seek(0);
      if (!this.exact) this.audio.play().catch(() => {});
    } else if (stepFrom(this.order, at, 1, repeat).index < 0) {
      this.set({ playing: false });
    } else {
      this.step(1, true);
    }
  }

  /** Where the song is, in seconds. Read this, not `audio.currentTime`, which restarts with every exact seek. */
  position(): number {
    if (this.pendingSeek !== null) return this.pendingSeek;
    return this.clockIsAbsolute ? this.audio.currentTime : this.streamStart + this.audio.currentTime;
  }

  /* ---------- Paths in the address bar (route.ts) ---------- */

  private writeRoute(route: Route, how: 'push' | 'replace'): void {
    const url = routeUrl(route);
    if (url === location.pathname + location.search) return;
    if (how === 'push') history.pushState(null, '', url);
    else history.replaceState(null, '', url);
  }

  /** The address of the lyrics view for the open song: its place on the NAS, or /playing for a song from this device. */
  private playRoute(): Route {
    const track = this.snapshot.currentTrack;
    const path = track?.nas ? pathOfTrackId(track.nas.id) : null;
    return path ? { kind: 'play', path, at: 0 } : track ? { kind: 'playing' } : { kind: 'home' };
  }

  /** The address of what the library is showing. A device album has none of its own. */
  private libraryRoute(): Route {
    const { page } = this.snapshot;
    return page.kind === 'album' ? { kind: 'album', path: page.path } : page.kind === 'artist' ? { kind: 'artist', name: page.name } : { kind: 'home' };
  }

  /** The address of the view that is showing. */
  private viewRoute(): Route {
    return this.snapshot.view === 'lyrics' ? this.playRoute() : this.libraryRoute();
  }

  /** Goes where an address says: from a link, or from the browser's back and forward buttons. */
  private async applyRoute(route: Route): Promise<void> {
    if (route.kind === 'home') {
      this.set({ songsOpen: false, view: 'library', page: { kind: 'home' } });
      return;
    }
    if (route.kind === 'playing') {
      // Only this visit's own songs have lyrics here; a reload has none, and lands on the library.
      if (this.snapshot.currentTrack && !this.snapshot.currentTrack.nas) this.set({ songsOpen: false, view: 'lyrics' });
      else {
        this.set({ songsOpen: false, view: 'library', page: { kind: 'home' } });
        this.writeRoute({ kind: 'home' }, 'replace');
      }
      return;
    }
    if (route.kind === 'artist') {
      this.set({ songsOpen: false, view: 'library', page: { kind: 'artist', name: route.name }, libraryQuery: '' });
      return;
    }
    if (!this.snapshot.pairing) {
      this.set({ songsOpen: false, view: 'library', page: { kind: 'home' }, notice: "This link is for a NAS this device isn't paired with. Ask its owner to send you an invite." });
      this.writeRoute({ kind: 'home' }, 'replace');
      return;
    }
    if (route.kind === 'album') {
      this.set({ songsOpen: false });
      await this.openAlbum(route.path);
      return;
    }
    if (route.kind === 'folders') {
      this.set({ songsOpen: true, songsTab: 'folders' });
      if (await this.openFolder(route.path, true)) return;
      await this.openFolder('');
      this.set({ notice: "The NAS doesn't have that folder any more." });
      this.writeRoute({ kind: 'folders', path: '' }, 'replace');
      return;
    }
    const id = `nas:${trackIdOf(route.path)}`;
    if (this.snapshot.currentId === id) {
      this.set({ songsOpen: false, view: 'lyrics' });
      return;
    }
    // The song's folder becomes the list it plays from, as if it had been chosen there.
    const found = await this.openFolder(folderOf(route.path), true);
    const track = found ? this.snapshot.nasFolder?.tracks.find((candidate) => candidate.id === id) : undefined;
    if (!track) {
      if (!found) await this.openFolder('');
      this.set({ songsOpen: true, notice: "The NAS doesn't have that song any more." });
      this.writeRoute({ kind: 'folders', path: this.snapshot.nasFolder?.path ?? '' }, 'replace');
      return;
    }
    this.set({ songsOpen: false });
    const list = this.snapshot.nasFolder?.tracks ?? [];
    this.setQueue(list, { kind: 'folder', path: folderOf(route.path) }, list.indexOf(track));
    // A page can't start sound without a tap, so a song opened from a link waits for Play.
    await this.select(track.id, false, 'none');
    if (route.at > 0 && this.snapshot.currentId === id) this.seek(route.at);
  }

  /* ---------- The library: albums and artists, from the NAS's scanned roots and this device's songs ---------- */

  /** Shows the library's front page. */
  showHome(): void {
    this.set({ view: 'library', page: { kind: 'home' }, libraryQuery: '', searchTracks: [], songsOpen: false });
    this.writeRoute({ kind: 'home' }, 'push');
  }

  /** Goes back to the library, where it was left. */
  showLibrary(): void {
    this.set({ view: 'library', songsOpen: false });
    this.writeRoute(this.libraryRoute(), 'push');
  }

  /** Shows the lyrics of the song that is open. */
  showLyrics(): void {
    if (!this.snapshot.currentTrack) return;
    this.set({ view: 'lyrics', songsOpen: false });
    this.writeRoute(this.playRoute(), 'push');
  }

  showArtist(name: string): void {
    this.set({ view: 'library', page: { kind: 'artist', name }, libraryQuery: '', searchTracks: [], songsOpen: false });
    this.writeRoute({ kind: 'artist', name }, 'push');
  }

  /** Shows an album made of songs from this device (they are grouped by their album tag). */
  showDeviceAlbum(name: string): void {
    this.set({ view: 'library', page: { kind: 'deviceAlbum', name }, libraryQuery: '', searchTracks: [], songsOpen: false });
  }

  /** Shows an album on the NAS, as a step the browser's back button can undo. */
  async showAlbum(path: string): Promise<void> {
    this.writeRoute({ kind: 'album', path }, 'push');
    await this.openAlbum(path);
  }

  private async openAlbum(path: string): Promise<void> {
    const pairing = this.snapshot.pairing;
    if (!pairing) return;
    const run = ++this.albumRun;
    this.set({ view: 'library', page: { kind: 'album', path }, libraryQuery: '', searchTracks: [], album: { path, state: 'loading', tracks: [], cover: null } });
    try {
      const folder = await fetchFolder(pairing, path);
      if (run !== this.albumRun) return;
      this.set({ album: { path, state: 'ready', cover: folder.cover ?? null, tracks: folder.tracks.map((track) => trackFromNas(track, folder.cover ?? null)) } });
    } catch (error) {
      if (run !== this.albumRun) return;
      if (error instanceof NasError && error.status === 404) this.set({ album: { path, state: 'missing', tracks: [], cover: null } });
      else {
        this.set({ album: { path, state: 'missing', tracks: [], cover: null } });
        this.nasFailed(error, "Can't open that album. Try again in a moment.");
      }
    }
  }

  /** Reads the NAS's library; while the NAS is still scanning, looks again shortly. */
  async loadLibrary(): Promise<void> {
    const pairing = this.snapshot.pairing;
    if (!pairing) return;
    clearTimeout(this.libraryTimer);
    if (this.snapshot.library.state === 'idle') this.set({ library: { ...this.snapshot.library, state: 'loading' } });
    try {
      const library = await fetchLibrary(pairing);
      if (this.snapshot.pairing !== pairing) return;
      this.set({ library: { state: library.enabled ? 'ready' : 'off', albums: library.albums, scanning: library.scanning } });
      if (library.scanning) this.libraryTimer = window.setTimeout(() => void this.loadLibrary(), 2500);
    } catch (error) {
      if (this.snapshot.pairing !== pairing) return;
      this.set({ library: { ...this.snapshot.library, state: 'error', scanning: false } });
      if (error instanceof NasError && error.status === 401) this.nasFailed(error, '');
    }
  }

  /** Asks the NAS to read its library again, for an album that was just added. */
  async rescanLibrary(): Promise<void> {
    const pairing = this.snapshot.pairing;
    if (!pairing) return;
    this.set({ library: { ...this.snapshot.library, scanning: true } });
    try {
      await startScan(pairing);
    } catch {
      // The library is read again below either way; a NAS that can't be reached shows there.
    }
    await this.loadLibrary();
  }

  /** Searches the library as the listener types: albums and artists at once here, songs from the NAS a moment later. */
  setLibraryQuery(libraryQuery: string): void {
    const wasLyrics = this.snapshot.view === 'lyrics';
    this.set({ libraryQuery, view: 'library', songsOpen: false, ...(libraryQuery.trim() ? {} : { searchTracks: [] }) });
    if (wasLyrics) this.writeRoute(this.libraryRoute(), 'push');
    clearTimeout(this.searchTimer);
    const query = libraryQuery.trim();
    const pairing = this.snapshot.pairing;
    if (query.length < 2 || !pairing || this.snapshot.library.state !== 'ready') return;
    this.searchTimer = window.setTimeout(async () => {
      try {
        const found = await searchLibrary(pairing, query);
        if (this.snapshot.libraryQuery.trim() === query) this.set({ searchTracks: found.tracks.map((track) => trackFromNas(track)) });
      } catch {
        // The albums and artists found here still show.
      }
    }, 250);
  }

  /** Opens the Songs panel, on the list asked for or the one it showed last. */
  openSongs(tab?: SongsTab): void {
    const { pairing, tracks } = this.snapshot;
    let songsTab = tab ?? this.snapshot.songsTab;
    if (!pairing) songsTab = 'device';
    else if (songsTab === 'device' && !tracks.length) songsTab = 'folders';
    this.set({ songsOpen: true, songsTab });
    if (songsTab === 'folders') this.showFolders();
  }

  /** The folder browser has an address; the other lists don't. */
  private showFolders(): void {
    const show = () => {
      const { songsOpen, songsTab, nasFolder } = this.snapshot;
      if (songsOpen && songsTab === 'folders') this.writeRoute({ kind: 'folders', path: nasFolder?.path ?? '' }, 'push');
    };
    if (this.snapshot.nasFolder) show();
    else void this.openFolder(loadLastPath()).then(show);
  }

  setSongsTab(songsTab: SongsTab): void {
    this.set({ songsTab });
    if (songsTab === 'folders') this.showFolders();
    else this.writeRoute(this.viewRoute(), 'replace');
  }

  closeSongs(): void {
    this.set({ songsOpen: false });
    this.writeRoute(this.viewRoute(), 'push');
  }

  /** Opens a NAS folder the listener chose, as a step the browser's back button can undo. */
  async browse(path: string): Promise<void> {
    await this.openFolder(path);
    if (this.snapshot.songsOpen && this.snapshot.nasFolder) this.writeRoute({ kind: 'folders', path: this.snapshot.nasFolder.path }, 'push');
  }

  /* ---------- Adding files ---------- */

  /** Adds picked or dropped files. `quiet` leaves out the notice about files that are neither audio nor lyrics (a whole folder was picked). */
  async addFiles(files: File[], quiet = false): Promise<void> {
    if (!files.length) return;
    const { tracks: added, looseLyrics, skipped } = await sortFiles(files);
    const current = this.current();
    let currentGotLyrics = false;

    // Lyrics that match no audio in this batch go to a track already here with that name, else to the song that
    // is open, else to the first new track, else they wait for the next audio file.
    const unplaced: File[] = [];
    for (const file of looseLyrics) {
      const owner = this.snapshot.tracks.find((track) => track.fileName && lyricsBelongTo(file.name, track.fileName));
      if (owner) {
        owner.lyricFiles.push(file);
        currentGotLyrics ||= owner === current;
      } else {
        unplaced.push(file);
      }
    }
    const target = current ?? added[0] ?? null;
    if (target) {
      target.lyricFiles.push(...this.waitingLyrics, ...unplaced);
      currentGotLyrics ||= target === current && (unplaced.length > 0 || this.waitingLyrics.length > 0);
      this.waitingLyrics = [];
    } else {
      this.waitingLyrics.push(...unplaced);
    }

    let notice = '';
    if (!quiet && skipped.length) notice = `${skipped.join(', ')} ${skipped.length === 1 ? 'is' : 'are'} not audio or lyrics, so ${skipped.length === 1 ? 'it was' : 'they were'} left out.`;
    else if (!target && this.waitingLyrics.length) notice = 'The lyrics are ready. Add the audio file to play them.';
    else if (quiet && !added.length && !looseLyrics.length) notice = 'That folder has no audio or lyrics files.';

    const tracks = [...this.snapshot.tracks, ...added];
    // A queue that is the device's songs grows with them.
    const grows = this.snapshot.queue === this.snapshot.tracks && this.snapshot.source.kind === 'device';
    this.set({ tracks, queue: grows ? tracks : this.snapshot.queue, notice });
    if (grows && current) this.order = makeOrder(tracks.length, this.snapshot.shuffle, tracks.indexOf(current));
    if (!current && added.length) await this.select(added[0].id, false);
    else if (current && currentGotLyrics) await this.loadLyrics(current, ++this.loadRun);
  }

  /* ---------- Playing ---------- */

  private async urlFor(track: Track): Promise<string> {
    if (track.file) {
      let url = this.urls.get(track.id);
      if (!url) {
        url = URL.createObjectURL(track.file);
        this.urls.set(track.id, url);
      }
      return url;
    }
    if (track.nas && this.snapshot.pairing) {
      const ticket = await fetchTicket(this.snapshot.pairing, track.nas.id);
      if (ticket.exactSeek && ticket.totalSeconds) this.exact = { index: null, total: ticket.totalSeconds };
      return ticket.url;
    }
    throw new Error('no audio');
  }

  private resetStream(): void {
    clearTimeout(this.seekTimer);
    this.seekRun++;
    this.finished = false;
    this.exact = null;
    this.streamStart = 0;
    this.clockIsAbsolute = false;
    this.clockChecked = false;
    this.pendingSeek = null;
    this.restarting = false;
    this.resumeAfterSeek = false;
    if (this.cutUrl) URL.revokeObjectURL(this.cutUrl);
    this.cutUrl = '';
  }

  /** Opens a track: its audio, then its lyrics. */
  async select(id: string, autoplay = true, history: 'push' | 'replace' | 'none' = 'push'): Promise<void> {
    // The queue first: Next, Back and a restored session name a song in it. A song found elsewhere (the first
    // file added on this device) makes that list the queue.
    const lists = [this.snapshot.queue, this.snapshot.tracks, this.snapshot.nasFolder?.tracks ?? []];
    const queue = lists.find((list) => list.some((candidate) => candidate.id === id));
    const track = queue?.find((candidate) => candidate.id === id);
    if (!track || !queue) return;
    if (queue !== this.snapshot.queue || this.order.length !== queue.length) {
      const source: QueueSource = queue === this.snapshot.tracks ? { kind: 'device' } : { kind: 'folder', path: this.snapshot.nasFolder?.path ?? '' };
      this.setQueue(queue, source, queue.indexOf(track));
    }
    const run = ++this.loadRun;
    const known = this.identified.get(id);
    this.source = null;
    this.audio.pause();
    this.resetStream();
    this.set({
      currentId: id, currentTrack: track, queue, song: null, lyricsLoading: true, lyricsNames: [], songInfo: known?.song ?? null, usInfo: known?.us ?? null,
      duration: track.durationSeconds ?? 0, notice: '', offset: this.offsets.get(offsetKey(track)) ?? 0,
      // Choosing a song shows its lyrics. Going on to the next song by itself leaves the listener where they are.
      ...(history === 'replace' ? {} : { view: 'lyrics' as const }),
    });
    this.saveSessionNow();
    // A NAS song has an address. A song from this device doesn't, so it only clears another song's address.
    // A song that follows on by itself while the library is showing leaves the library's address alone.
    if (history === 'push' || (history === 'replace' && this.snapshot.view === 'lyrics')) this.writeRoute(this.playRoute(), history);
    this.updateMediaSession();
    try {
      // A song from a playlist or a saved session is looked up again first: its lyrics files and cover may have changed.
      if (track.stale && !(await this.freshen(track))) {
        if (run === this.loadRun) this.set({ lyricsLoading: false, notice: `The NAS doesn't have "${track.title}" any more.` });
        return;
      }
      if (run !== this.loadRun) return;
      if (track.nas) this.set({ duration: track.durationSeconds ?? 0 });
      const url = await this.urlFor(track);
      if (run !== this.loadRun) return;
      if (track.file) {
        // A FLAC file on the device gets its index read first (a few small reads), so that every seek is exact.
        const index = await readFlacIndex(fileReader(track.file), track.file.size).catch(() => null);
        if (run !== this.loadRun) return;
        if (index) this.exact = { index, total: index.totalSamples / index.sampleRate };
      }
      if (this.exact) this.set({ duration: this.exact.total });
      this.audio.src = url;
      if (autoplay) this.audio.play().catch(() => {});
    } catch (error) {
      if (run !== this.loadRun) return;
      this.nasFailed(error, `Can't get ${track.title} from the NAS.`);
    }
    await this.loadLyrics(track, run);
  }

  private async loadLyrics(track: Track, run: number): Promise<void> {
    const texts: { text: string; name: string }[] = [];
    const unreadable: string[] = [];
    const pairing = this.snapshot.pairing;
    for (const file of track.nas && pairing ? track.nas.lyrics : []) {
      try {
        texts.push({ text: await fetchLyrics(pairing!, track.nas!.id, file.index), name: file.name });
      } catch {
        unreadable.push(file.name);
      }
    }
    for (const file of track.lyricFiles) {
      try {
        texts.push({ text: await file.text(), name: file.name });
      } catch {
        unreadable.push(file.name);
      }
    }
    if (run !== this.loadRun) return;

    let source: LyricsSource | null = null;
    const otherSong: string[] = [];
    for (const item of texts) {
      let opened: LyricsSource;
      try {
        opened = openLyrics(item.text, item.name);
      } catch {
        unreadable.push(item.name);
        continue;
      }
      if (!source) source = opened;
      else if (sameSong(source, opened)) mergeInto(source, opened);
      else otherSong.push(item.name);
    }
    this.source = source;

    let notice = this.snapshot.notice;
    if (unreadable.length) notice = `Can't read lyrics from ${unreadable.join(', ')}. Use an Apple Music lyrics JSON, a TTML file or an LRC file.`;
    else if (otherSong.length) notice = `${otherSong.join(', ')} ${otherSong.length === 1 ? 'has' : 'have'} different lyrics from ${source!.names[0]}, so ${otherSong.length === 1 ? 'it was' : 'they were'} left out.`;
    const song = source ? songFromDoc(source.doc) : null;
    this.set({ song, lyricsLoading: false, lyricsNames: source ? [...source.names] : [], notice });

    // The song's Apple Music id comes with its lyrics, or failing that from its tags.
    const catalogId = source?.catalogId || track.appleSongId || '';
    if (catalogId && !this.identified.has(track.id)) {
      try {
        const found = await identify(catalogId, song?.language ?? '');
        this.identified.set(track.id, found);
        if (run === this.loadRun) {
          this.set({ songInfo: found.song, usInfo: found.us });
          this.updateMediaSession();
        }
      } catch {
        // Offline, or Apple is unreachable: the track's own tags name it.
      }
    }
  }

  toggle(): void {
    if (!this.snapshot.currentId) return;
    if (this.finished) {
      this.finished = false;
      // Play again from the start. For a stream cut by an exact seek that means the song's start, not the stream's.
      this.resumeAfterSeek = true;
      this.seek(0);
      if (!this.exact) this.audio.play().catch(() => {});
    } else if (this.audio.paused) this.audio.play().catch(() => {});
    else this.audio.pause();
  }

  /** Moves to the next (1) or previous (-1) track in the list. */
  step(direction: 1 | -1, autoplay = !this.audio.paused): void {
    const { queue, currentId, repeat, shuffle } = this.snapshot;
    const at = queue.findIndex((track) => track.id === currentId);
    const next = stepFrom(this.order, at, direction, repeat);
    // Back goes to the start of the song first, as music players do; only from there to the song before.
    if (direction === -1 && (this.position() > 3 || next.index < 0)) {
      this.seek(0);
      return;
    }
    if (next.index < 0) return;
    let target = next.index;
    if (next.wrapped && shuffle && direction === 1 && queue.length > 1) {
      // Coming round a shuffled queue plays it in a new order, not starting with the song that just played.
      do this.order = makeOrder(queue.length, true); while (this.order[0] === at);
      target = this.order[0];
    }
    void this.select(queue[target].id, autoplay, 'replace');
  }

  /** Whether Next leads anywhere. */
  canGoNext(): boolean {
    const { queue, currentId, repeat } = this.snapshot;
    return stepFrom(this.order, queue.findIndex((track) => track.id === currentId), 1, repeat).index >= 0;
  }

  /** Makes a list the queue, in the order it will play. */
  private setQueue(queue: Track[], source: QueueSource, current = -1): void {
    this.order = makeOrder(queue.length, this.snapshot.shuffle, current);
    this.set({ queue, source });
  }

  /**
   * Plays a list from the song chosen in it; with no song chosen, from its first (or, shuffled, from any). The
   * list becomes the queue, so Next, Back, repeat and shuffle work through it.
   */
  async playFrom(list: Track[], source: QueueSource, id?: string): Promise<void> {
    if (!list.length) return;
    const chosen = id ? list.findIndex((track) => track.id === id) : -1;
    this.setQueue(list, source, chosen);
    await this.select(list[chosen >= 0 ? chosen : this.order[0]].id, true, 'push');
  }

  cycleRepeat(): void {
    this.set({ repeat: nextRepeat(this.snapshot.repeat) });
    this.keepSettings();
  }

  toggleShuffle(): void {
    const { queue, currentId } = this.snapshot;
    const shuffle = !this.snapshot.shuffle;
    // The open song stays where it is: shuffled, the rest follow it at random; unshuffled, the list carries on from it.
    this.order = makeOrder(queue.length, shuffle, queue.findIndex((track) => track.id === currentId));
    this.set({ shuffle });
    this.keepSettings();
  }

  private keepSettings(): void {
    const { showRoman, showTranslation, repeat, shuffle, sweepLines } = this.snapshot;
    saveSettings({ showRoman, showTranslation, repeat, shuffle, sweepLines });
  }

  /* ---------- Picking up where the listener left off ---------- */

  private saveSessionNow(): void {
    const { pairing, currentTrack, queue, source } = this.snapshot;
    // Only NAS songs can come back: a file picked on the device is gone once the page is.
    if (!pairing || !currentTrack?.nas || source.kind === 'device') return;
    saveSession({
      nas: pairing.base,
      source,
      tracks: queue.filter((track) => track.nas).map(savedOf),
      current: currentTrack.nas.id,
      position: this.finished ? 0 : this.position(),
    });
  }

  /** On the first screen, offers the session saved last time, if it was on the NAS this device is paired with. */
  private offerResume(): void {
    const saved = loadSession();
    if (saved && this.snapshot.pairing && saved.nas === this.snapshot.pairing.base) this.set({ resume: saved });
  }

  /** Takes up the offer: the same queue, the same song, from where it stopped. */
  async resumeSession(): Promise<void> {
    const saved = this.snapshot.resume;
    if (!saved) return;
    const queue = saved.tracks.map(fromSaved);
    const id = `nas:${saved.current}`;
    this.setQueue(queue, saved.source, queue.findIndex((track) => track.id === id));
    this.set({ resume: null });
    await this.select(id, false, 'push');
    if (this.snapshot.currentId !== id || !this.audio.src) return;
    if (saved.position > 1) {
      this.resumeAfterSeek = true;
      this.seek(saved.position);
      if (this.exact) return;
    }
    this.audio.play().catch(() => {});
  }

  /** Looks a NAS song up again in its folder. False when the NAS no longer has it. */
  private async freshen(track: Track): Promise<boolean> {
    const pairing = this.snapshot.pairing;
    const path = track.nas ? pathOfTrackId(track.nas.id) : null;
    if (!pairing || !track.nas || !path) return false;
    let folder;
    try {
      folder = await fetchFolder(pairing, folderOf(path));
    } catch (error) {
      if (error instanceof NasError && error.status === 404) return false;
      throw error;
    }
    const fresh = folder.tracks.find((candidate) => candidate.id === track.nas?.id);
    if (!fresh) return false;
    Object.assign(track, trackFromNas(fresh, folder.cover ?? null), { lyricFiles: track.lyricFiles, stale: false });
    return true;
  }

  /* ---------- Playlists (persist.ts) ---------- */

  private setPlaylists(playlists: Playlist[]): void {
    this.set({ playlists });
    if (this.snapshot.pairing) savePlaylists(this.snapshot.pairing.base, playlists);
  }

  private changePlaylist(id: string, change: (playlist: Playlist) => Playlist): void {
    this.setPlaylists(this.snapshot.playlists.map((playlist) => (playlist.id === id ? change(playlist) : playlist)));
  }

  /** Makes a playlist, with any songs given in it, and opens it in the panel. */
  createPlaylist(name: string, tracks: Track[] = [], show = true): void {
    const id = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const playlist = withTracks({ id, name: cleanName(name), tracks: [] }, tracks.filter((track) => track.nas).map(savedOf));
    this.setPlaylists([...this.snapshot.playlists, playlist]);
    if (show) this.set({ openPlaylist: id, songsTab: 'playlists' });
    // Made from a song's row, the playlist isn't opened; say that it exists.
    else this.set({ notice: `Made ${playlist.name} with ${playlist.tracks.length} ${playlist.tracks.length === 1 ? 'song' : 'songs'}.` });
  }

  /** Adds NAS songs to a playlist, each once, and says what happened. */
  addToPlaylist(id: string, tracks: Track[]): void {
    const playlist = this.snapshot.playlists.find((candidate) => candidate.id === id);
    if (!playlist) return;
    const next = withTracks(playlist, tracks.filter((track) => track.nas).map(savedOf));
    const added = next.tracks.length - playlist.tracks.length;
    this.changePlaylist(id, () => next);
    this.set({ notice: added ? `Added ${added} ${added === 1 ? 'song' : 'songs'} to ${playlist.name}.` : `${tracks.length === 1 ? 'That song is' : 'Those songs are'} already in ${playlist.name}.` });
  }

  removeFromPlaylist(id: string, index: number): void { this.changePlaylist(id, (playlist) => withoutTrack(playlist, index)); }
  moveInPlaylist(id: string, index: number, direction: 1 | -1): void { this.changePlaylist(id, (playlist) => withMoved(playlist, index, direction)); }
  renamePlaylist(id: string, name: string): void { this.changePlaylist(id, (playlist) => ({ ...playlist, name: cleanName(name) })); }

  deletePlaylist(id: string): void {
    this.setPlaylists(this.snapshot.playlists.filter((playlist) => playlist.id !== id));
    if (this.snapshot.openPlaylist === id) this.set({ openPlaylist: null });
  }

  showPlaylist(id: string | null): void { this.set({ openPlaylist: id }); }

  /** Plays a playlist from the song at `index`, or from its start. */
  async playPlaylist(id: string, index?: number): Promise<void> {
    const playlist = this.snapshot.playlists.find((candidate) => candidate.id === id);
    if (!playlist?.tracks.length) return;
    const list = playlist.tracks.map(fromSaved);
    await this.playFrom(list, { kind: 'playlist', id }, index === undefined ? undefined : list[index]?.id);
  }

  seek(time: number): void {
    if (!this.snapshot.currentId) return;
    const target = Math.max(0, Math.min(time, this.snapshot.duration || time));
    this.seekCount++;
    if (!this.exact) {
      this.audio.currentTime = target;
      return;
    }
    // Show the time asked for at once, and restart the stream a moment later: dragging the seek bar asks many times.
    this.pendingSeek = target;
    clearTimeout(this.seekTimer);
    this.seekTimer = window.setTimeout(() => void this.restartAt(target), 120);
  }

  /** Plays a new stream that begins at the frame holding `target`. */
  private async restartAt(target: number): Promise<void> {
    const track = this.current();
    const exact = this.exact;
    if (!track || !exact) return;
    const run = ++this.seekRun;
    this.resumeAfterSeek ||= !this.audio.paused;
    let url = '';
    let cut = false;
    let start = 0;
    try {
      if (track.file && exact.index) {
        const found = await flacStartAt(fileReader(track.file), exact.index, target);
        if (found.startSample > 0) {
          url = URL.createObjectURL(new Blob([streamHeader(exact.index, found.startSample), track.file.slice(found.offset)], { type: 'audio/flac' }));
          cut = true;
          start = found.startSeconds;
        } else {
          url = await this.urlFor(track);
        }
      } else if (track.nas && this.snapshot.pairing) {
        const ticket = await fetchTicket(this.snapshot.pairing, track.nas.id, target);
        url = ticket.url;
        start = ticket.startSeconds;
      } else {
        return;
      }
    } catch (error) {
      if (run !== this.seekRun) return;
      this.pendingSeek = null;
      this.nasFailed(error, "Can't move to that part of the song. Try again in a moment.");
      return;
    }
    if (run !== this.seekRun) {
      if (cut) URL.revokeObjectURL(url);
      return;
    }

    const resume = this.resumeAfterSeek;
    this.resumeAfterSeek = false;
    const old = this.cutUrl;
    this.restarting = resume;
    this.audio.src = url;
    this.cutUrl = cut ? url : '';
    if (old) URL.revokeObjectURL(old);
    this.streamStart = start;
    this.clockIsAbsolute = false;
    this.clockChecked = false;
    const ready = () => {
      if (run !== this.seekRun) return;
      // Before it has played, the new stream's time is 0 or the time it begins at; which one says how to read it.
      if (start > 0.5) {
        this.clockIsAbsolute = this.audio.currentTime >= start - 0.25;
        this.browserClockIsAbsolute = this.clockIsAbsolute;
      } else {
        this.clockIsAbsolute = start > 0 && (this.browserClockIsAbsolute ?? false);
      }
      this.pendingSeek = null;
      this.restarting = false;
    };
    this.audio.addEventListener('canplay', ready, { once: true });
    this.audio.addEventListener('error', ready, { once: true });
    if (resume) this.audio.play().catch(() => { this.restarting = false; this.set({ playing: false }); });
  }

  /** Shifts the open song's lyrics. The shift is the song's own, and is kept for the next time it plays. */
  nudge(seconds: number): void {
    const offset = Math.round((this.snapshot.offset + seconds) * 100) / 100;
    this.set({ offset });
    const track = this.current();
    if (track) saveOffset(this.offsets, offsetKey(track), offset);
  }

  setVolume(volume: number): void {
    const level = Math.max(0, Math.min(1, volume));
    this.audio.volume = level;
    this.audio.muted = false;
    try {
      localStorage.setItem(VOLUME_KEY, String(level));
    } catch {
      // Without storage the volume lasts until the tab closes.
    }
    this.set({ volume: level, muted: false });
  }

  toggleMute(): void {
    const muted = !this.snapshot.muted;
    this.audio.muted = muted;
    // Unmuting a volume of nothing would still be silent.
    if (!muted && this.snapshot.volume === 0) this.setVolume(0.5);
    else this.set({ muted });
  }

  setShowRoman(showRoman: boolean): void { this.set({ showRoman }); this.keepSettings(); }
  setShowTranslation(showTranslation: boolean): void { this.set({ showTranslation }); this.keepSettings(); }
  setSweepLines(sweepLines: boolean): void { this.set({ sweepLines }); this.keepSettings(); }
  dismissNotice(): void { this.set({ notice: '' }); }

  /* ---------- Naming the song ---------- */

  /** Names the open song after a search result picked in the given storefront. */
  async useSong(song: AppleSong, country: string): Promise<void> {
    const id = this.snapshot.currentId;
    if (!id) return;
    const run = this.loadRun;
    this.identified.set(id, { song, us: null });
    this.set({ songInfo: song, usInfo: null });
    this.updateMediaSession();
    try {
      const found = await counterpart(song, country, this.snapshot.song?.language ?? '');
      this.identified.set(id, found);
      if (run === this.loadRun && this.snapshot.currentId === id) {
        this.set({ songInfo: found.song, usInfo: found.us });
        this.updateMediaSession();
      }
    } catch {
      // The picked name stands on its own.
    }
  }

  /** Saves the current song's combined lyrics as one file. */
  downloadLyrics(): void {
    if (!this.source) return;
    const saved = serialize(this.source);
    const { songInfo } = this.snapshot;
    const track = this.current();
    const label = songInfo ? `${songInfo.artistName} - ${songInfo.trackName}` : track?.title || 'song';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([saved.text], { type: saved.type }));
    link.download = `${label.replace(/[\\/:*?"<>|]/g, '_')} (combined lyrics).${saved.extension}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  /* ---------- NAS ---------- */

  private nasFailed(error: unknown, fallback: string): void {
    if (error instanceof NasError && error.status === 401) {
      clearPairing();
      this.set({
        pairing: null, nasState: 'idle', nasFolder: null, playlists: [], openPlaylist: null, resume: null, songsTab: 'device',
        library: { state: 'idle', albums: [], scanning: false }, album: null, page: { kind: 'home' }, searchTracks: [],
        notice: 'This device is no longer paired with the NAS. Ask its owner for a new invite.',
      });
      this.writeRoute({ kind: 'home' }, 'replace');
    } else {
      this.set({ notice: error instanceof NasError ? NAS_MESSAGES[error.code] ?? fallback : fallback });
    }
  }

  /** Shows a folder of the NAS in the browser; '' shows its roots. */
  /**
   * Shows a folder of the NAS in the browser; '' shows its roots. Resolves to whether that folder is now shown.
   * A folder the NAS doesn't have falls back to the roots, unless `strict`, where the caller says what happens.
   */
  async openFolder(path: string, strict = false): Promise<boolean> {
    const pairing = this.snapshot.pairing;
    if (!pairing) return false;
    const run = ++this.browseRun;
    this.set({ nasState: 'loading' });
    try {
      const folder = await fetchFolder(pairing, path);
      if (run !== this.browseRun) return false;
      saveLastPath(folder.path);
      this.set({
        nasState: 'ready',
        nasFolder: {
          path: folder.path, parent: folder.parent, folders: folder.folders, cover: folder.cover ?? null,
          tracks: folder.tracks.map((track) => trackFromNas(track, folder.cover ?? null)),
        },
      });
      return true;
    } catch (error) {
      if (run !== this.browseRun) return false;
      if (error instanceof NasError && error.status === 404 && path) {
        // The folder remembered from last time is gone: start again from the roots.
        if (!strict) await this.openFolder('');
        else this.set({ nasState: 'ready' });
        return false;
      }
      this.set({ nasState: 'error' });
      this.nasFailed(error, "Can't open that folder on the NAS. Try again in a moment.");
      return false;
    }
  }

  async refreshNas(): Promise<void> {
    await this.openFolder(this.snapshot.nasFolder?.path ?? '');
  }

  /** Starts pairing from a typed address and code; the person still confirms the server first. */
  proposePair(link: PairLink): void { this.set({ pendingPair: link, pairError: '' }); }
  cancelPair(): void { this.set({ pendingPair: null, pairError: '' }); }

  async confirmPair(deviceName: string): Promise<void> {
    const link = this.snapshot.pendingPair;
    if (!link) return;
    try {
      const pairing = await pair(link, deviceName);
      this.set({ pairing, pendingPair: null, pairError: '', nasFolder: null, playlists: loadPlaylists(pairing.base), openPlaylist: null, songsTab: 'folders' });
      void this.loadLibrary();
      await this.openFolder('');
    } catch (error) {
      this.set({ pairError: (error instanceof NasError && NAS_MESSAGES[error.code]) || "Pairing didn't finish. Check the address and try again." });
    }
  }

  async forgetNas(): Promise<void> {
    const pairing = this.snapshot.pairing;
    if (!pairing) return;
    const playingFromNas = this.current()?.origin === 'nas';
    if (playingFromNas) {
      this.loadRun++;
      this.source = null;
      this.resetStream();
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    this.set({
      pairing: null, nasState: 'idle', nasFolder: null, playlists: [], openPlaylist: null, resume: null, songsTab: 'device',
      library: { state: 'idle', albums: [], scanning: false }, album: null, page: { kind: 'home' }, searchTracks: [], view: 'library',
      ...(playingFromNas ? { currentId: null, currentTrack: null, queue: [], song: null, lyricsNames: [], songInfo: null, usInfo: null } : {}),
    });
    this.writeRoute({ kind: 'home' }, 'replace');
    await forget(pairing);
  }

  /* ---------- Lock screen and media keys ---------- */

  private wireMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => this.toggle()],
      ['pause', () => this.toggle()],
      ['previoustrack', () => this.step(-1)],
      ['nexttrack', () => this.step(1)],
      ['seekto', (details) => { if (details.seekTime !== undefined) this.seek(details.seekTime); }],
    ];
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // This browser doesn't offer the action.
      }
    }
  }

  private updateMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const track = this.current();
    const { songInfo } = this.snapshot;
    navigator.mediaSession.metadata = track
      ? new MediaMetadata({
          title: songInfo?.trackName ?? track.title,
          artist: songInfo?.artistName ?? track.artist,
          album: songInfo?.collectionName ?? track.album,
          artwork: track.cover
            ? [{ src: track.cover }]
            : songInfo?.artworkUrl100 ? [{ src: songInfo.artworkUrl100.replace('100x100', '512x512'), sizes: '512x512' }] : [],
        })
      : null;
  }
}

const VOLUME_KEY = 'taiko:volume';

function loadVolume(): number {
  try {
    const stored = Number(localStorage.getItem(VOLUME_KEY) ?? '1');
    return Number.isFinite(stored) && stored >= 0 && stored <= 1 ? stored : 1;
  } catch {
    return 1;
  }
}

/** Whether a page may set the volume here. On an iPhone the setting is ignored and reads back as 1. */
function volumeCanBeSet(): boolean {
  const probe = new Audio();
  probe.volume = 0.5;
  return probe.volume === 0.5;
}

/** What names a song for its saved lyric timing: its place on the NAS, or its file name on this device. */
const offsetKey = (track: Track): string => (track.nas ? `nas:${track.nas.id}` : `file:${track.fileName}`);

/** A NAS song as it is stored in a playlist or a session. */
function savedOf(track: Track): SavedTrack {
  const { lyrics: _lyrics, ...saved } = track.nas!;
  return saved;
}

/** A stored song as a track. It is looked up again before it plays (`stale`). */
const fromSaved = (saved: SavedTrack): Track => ({ ...trackFromNas({ ...saved, lyrics: [] }), stale: true });

/** Reads parts of a file picked on this device. */
function fileReader(file: File): Reader {
  return async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
}

export const store = new PlayerStore();
