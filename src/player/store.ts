/**
 * The player's state, as an external store the UI reads with `useSyncExternalStore` (no state library). It owns
 * the one `<audio>` element. Time-driven display (the lyric fill, the seek bar) reads `store.audio.currentTime`
 * each animation frame instead of going through snapshots.
 */
import { counterpart, identify } from '../apple/catalog';
import type { AppleSong, Identified } from '../apple/catalog';
import { forgetKept, keepFiles, loadKept } from '../library/kept';
import { keepSet, keepTrack, loadOffline, offlineTrack, removeSet, removeStrays, storageUse } from '../library/offline';
import type { KeptFile } from '../library/kept';
import { smallCover, sortFiles, trackFromNas } from '../library/tracks';
import type { Track } from '../library/tracks';
import { mergeInto, sameSong, serialize } from '../lyrics/merge';
import { openLyrics, songFromDoc } from '../lyrics/ttml';
import type { LyricsSource, Song } from '../lyrics/ttml';
import {
  NasError, clearPairing, fetchFolder, fetchLibrary, fetchFavourites, fetchHistory, fetchLyrics, fetchMoved, fetchPlayCounts, fetchPlaylists, fetchSharedPlaylists, fetchTicket, fetchUser, forget, loadLastPath, loadPairing, makeInvite, pair, parsePairLink, reportPlay, saveLastPath, savePairing, searchLibrary, sendPlaylists, sendSharedTracks, setFavouriteAlbum, setFavouriteSong, startScan,
} from '../nas/client';
import type { PairLink, Pairing } from '../nas/client';
import { lyricsBelongTo, pathOfTrackId, trackIdOf } from '../shared/api';
import { joinRoom, openLive, sendCommand, sendState, shareRoom } from '../nas/live';
import { noteChanges, reconcile, transitionKey, withoutLostTransitions } from '../shared/playlists';
import type { PlaylistAccess, SharedPlaylist, Transition } from '../shared/playlists';
import { MAX_SHARED_QUEUE } from '../shared/api';
import type { FavouritesResponse, HistoryResponse, InviteResponse, LiveDevice, NasUser, PlaybackState, RemoteCommand, Room, RoomState } from '../shared/api';
import {
  cleanName, loadOffsets, loadPendingPlays, loadPlaylistSync, loadPlaylists, loadSession, loadSettings, saveOffset, savePendingPlays, savePlaylistSync, savePlaylists, saveSession, saveSettings, withMoved, withTracks, withoutTrack,
} from './persist';
import type { Playlist, QueueSource, SavedTrack, Session } from './persist';
import { levelFactor } from './level';
import { castPossible } from './cast';
import { enginePossible } from './engine';
import { CAST_DECK, Decks, keepMixerWanted, mixerPossible, mixerWanted } from './mixer';
import type { Player } from './mixer';
import { inPlayOrder, makeOrder, nextRepeat, stepFrom, withMovedInQueue, withQueued, withoutQueued, withoutUpcoming } from './queue';
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

/** An album or playlist kept on this device, as the screens list it. */
export interface KeptSet {
  key: string;
  kind: 'album' | 'playlist';
  title: string;
  detail: string;
  tracks: SavedTrack[];
  bytes: number;
  /** An address for its cover, made from the kept picture. */
  cover: string | null;
}

export interface OfflineView {
  sets: KeptSet[];
  /** The NAS ids of every song stored. */
  ids: string[];
  /** What is being kept right now, and how far along it is. */
  busy: { key: string; title: string; done: number; total: number } | null;
  /** What the browser stores for the site, and about how much it may; null where it won't say. */
  use: { used: number; quota: number } | null;
}

export const albumKey = (path: string): string => `album:${path}`;
export const playlistKey = (id: string): string => `playlist:${id}`;

export type SongsTab = 'queue' | 'folders' | 'playlists' | 'device' | 'devices' | 'together';

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
  /** Whether pressing a lyric line moves the song to it. */
  seekOnLine: boolean;
  /** Whether songs are brought to about the same loudness (see level.ts). */
  levelVolume: boolean;
  /** Seconds one song fades into the next; 0 for none. */
  crossfade: number;
  /** Casting to a Google Cast speaker or TV (cast.ts): whether this browser can, and the device's name while it is on. */
  canCast: boolean;
  casting: string;
  /** Whether an album's songs are joined without a gap, by playing FLAC songs on the engine (engine.ts); and whether this browser could. */
  gapless: boolean;
  canGapless: boolean;
  /** This NAS's playlists, kept in the browser. */
  playlists: Playlist[];
  /** The playlist open in the panel, or null for the list of them. */
  openPlaylist: string | null;
  /** Whether the playlists are kept on the NAS, for all of this user's devices. */
  playlistsShared: boolean;
  /** Whose device this is, on a NAS that has users. */
  user: NasUser | null;
  /** The playlists other users let this one see, and the one of them that is open (`<owner id>/<playlist id>`). */
  sharedPlaylists: SharedPlaylist[];
  openShared: string | null;
  /** An invite just made for another device of this user, while it is shown. */
  deviceInvite: InviteResponse | null;
  /** The user's favourite songs and albums; null when the NAS keeps none (or there is no NAS). */
  favourites: FavouritesResponse | null;
  /** The user's listening, as the NAS last gave it; null until it is read, or when the NAS keeps none. */
  history: HistoryResponse | null;
  /** How often the user has played the songs of the album that is open. */
  playCounts: Record<string, number>;
  /** NAS songs kept on this device to play with no connection. */
  offline: OfflineView;
  /** The user's other devices that have the player open, and what each is playing (remote control). */
  devices: LiveDevice[];
  /** Whether the live connection to the NAS is up (it carries remote control and listening together). */
  live: boolean;
  /** Listening together: who else is sharing what they play, whether this device is, and whom it is listening along with. */
  rooms: Room[];
  sharing: boolean;
  /** How many are listening along with this device while it shares. */
  listeners: number;
  joined: string | null;
  /** Where the listener was last time, offered on the first screen. */
  /** From 0 to 1. */
  volume: number;
  muted: boolean;
  /** False where only the device's own buttons set the volume (an iPhone): the slider is left out there. */
  canSetVolume: boolean;
  /**
   * Whether the song plays through the mixer (mixer.ts), which is how its volume is levelled where a page can't set
   * an audio element's volume; and whether this browser could.
   */
  mixing: boolean;
  canMix: boolean;
  /** Whether there is an AirPlay speaker or screen to send the sound to (Safari only). */
  canAirplay: boolean;
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
  /** The two players a song can sound from; one plays, the other waits for a crossfade (mixer.ts). */
  private readonly decks = new Decks();
  private active = 0;
  /** The element the open song plays on. It changes at a crossfade, when the next song starts on the other one. */
  get audio(): HTMLAudioElement { return this.decks.players[this.active] as HTMLAudioElement; }
  /** The mixer's parts as the tests look at them: its context, the open song's level, and the speaker. */
  get mixer(): { context: AudioContext; gain: GainNode; speaker: HTMLAudioElement } | null {
    const mixer = this.decks.mixer;
    return mixer ? { context: mixer.context, gain: mixer.levels[this.active], speaker: mixer.speaker } : null;
  }
  private snapshot: Snapshot = {
    tracks: [], queue: [], currentId: null, currentTrack: null, song: null, lyricsLoading: false, lyricsNames: [], songInfo: null, usInfo: null,
    playing: false, duration: 0, offset: 0, ...loadSettings(), notice: '',
    view: 'library', page: { kind: 'home' }, library: { state: 'idle', albums: [], scanning: false }, album: null, libraryQuery: '', searchTracks: [],
    pairing: START_PAIRING, nasState: 'idle', nasFolder: null, songsOpen: false, songsTab: START_PAIRING ? 'folders' : 'device', source: { kind: 'device' },
    playlists: START_PAIRING ? loadPlaylists(START_PAIRING.base) : [], openPlaylist: null, playlistsShared: false, user: START_PAIRING?.user ?? null, sharedPlaylists: [], openShared: null, deviceInvite: null, favourites: null, history: null, playCounts: {}, offline: { sets: [], ids: [], busy: null, use: null }, devices: [], live: false, rooms: [], sharing: false, listeners: 0, joined: null, volume: loadVolume(), muted: false, canSetVolume: volumeCanBeSet(), mixing: false, canMix: mixerPossible(), canGapless: enginePossible(), canCast: castPossible(), casting: '', canAirplay: false, pendingPair: null, pairError: '',
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
  private positionTold = 0;
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
  private restTimer = 0;
  /** During a crossfade: the element the song before is fading out on, and what to tidy when it is done. */
  private fading: { element: Player; deck: number; cutUrl: string; timer: number } | null = null;
  /** The next song of an album, already loading on the engine to begin where the open one ends (gapless playback). */
  private prepared: { id: string; deck: number; exact: PlayerStore['exact'] } | null = null;
  private prepareRun = 0;
  /** Seconds into the next song to start it at, set by a join the listener shaped and used once by `select`. */
  private startNextAt = 0;
  /** A moment the listener sought to while the open song was still being fetched; it starts there. */
  private wantedStart: number | null = null;
  /** A join being tried out before it is kept: which one, and how. */
  private trying: { key: string; transition: Transition } | null = null;
  private preparing = false;
  /** Seconds the song now starting is to fade in over; 0 outside a crossfade. */
  private fadeIn = 0;
  /** True while a crossfade is moving on to its next song, so that choosing that song doesn't end the fade. */
  private handingOver = false;
  /** The song played to its end. The element's own `ended` can't be trusted for a stream cut by an exact seek. */
  private finished = false;
  /** Whether the open song's own stream has been given to the audio element (see `songEnded`). */
  private streamLoaded = false;
  /** Seconds of the open song really heard (not skipped over), where the last sample was taken, and whether the NAS was told. */
  private heard = 0;
  private heardFrom = -1;
  private playTold = false;
  private resumeAfterSeek = false;
  /** Counts changes to the playlists made on this device, so a sync can tell one happened while it ran. */
  private playlistEdits = 0;
  private syncing = false;
  /** The live connection to the NAS: how to close it, this device's id on it, and whether it is up. */
  private stopLive: (() => void) | null = null;
  private myDevice = '';
  private liveUp = false;
  private reportTimer = 0;
  private lastQueueTold: Track[] | null = null;
  private lastOrderTold: number[] | null = null;
  /** Whom this device was listening along with at the last word on it, and whether a song is being opened to follow them. */
  private wasFollowing: string | null = null;
  private followingNow = false;
  private keepRun = 0;
  private offlineRead: Promise<void> = Promise.resolve();
  private readonly keptCovers = new Map<string, string>();
  private sendingPlays = false;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  /** While a saved session is being restored, the moment it is going back to. */
  private restoringAt: number | null = null;
  /** The object URL of the cut stream now playing, for a file on this device. */
  private cutUrl = '';
  /** Goes up on every seek, so the lyrics know to follow the song again. */
  seekCount = 0;

  constructor() {
    for (const element of this.decks.elements) element.preload = 'auto';
    this.decks.setVolume(this.snapshot.volume);
    // Where the listener turned the mixer on, the elements are taken into it before any song is loaded.
    if (mixerWanted() && this.snapshot.canMix) this.startMixer();
    // What the song's own element says is heard from both decks, and acted on only for the one the song is on: the
    // other is idle, or playing out the end of the song before during a crossfade.
    const on = (type: string, handler: (event: Event) => void): void => {
      for (const [deck, player] of this.decks.players.entries()) player.addEventListener(type, (event: Event) => { if (deck === this.active) handler(event); });
    };
    // The song before, fading out, ends: the crossfade is over.
    for (const [deck, player] of this.decks.players.entries()) player.addEventListener('ended', () => { if (this.fading?.deck === deck) this.endFade(); });
    // The lock screen's buttons are claimed again each time sound starts: iOS only honours them once audio is
    // playing, and goes back to its own skip-10-seconds buttons otherwise.
    on('play', () => { this.reportState(); this.decks.wake(); this.set({ playing: true }); this.wireMediaSession(); this.tellPosition(); this.sayPlaying(true); });
    // Loading a restarted stream pauses the element for a moment; that isn't the listener pausing.
    on('pause', () => {
      if (this.restarting) return;
      this.set({ playing: false });
      this.tellPosition();
      this.sayPlaying(false);
      // The speaker rests a moment later, unless this was only the pause between two songs.
      clearTimeout(this.restTimer);
      this.restTimer = window.setTimeout(() => { if (this.audio.paused && !this.restarting) this.decks.rest(); }, 2000);
      // A stream cut by an exact seek can stop at its end without the browser ever saying it ended (Chrome, whose
      // clock for such a stream doesn't line up with its length). Stopping at the song's end is the end.
      if (this.exact && this.position() >= this.exact.total - 0.3) this.songEnded();
    });
    on('durationchange', () => {
      // A restarted stream reports only what remains; an exact-seek track's length comes from its index.
      if (!this.exact && Number.isFinite(this.audio.duration)) this.set({ duration: this.audio.duration });
    });
    on('timeupdate', () => {
      if (Date.now() - this.positionTold > 1000) this.tellPosition();
      this.noteHeard();
      this.maybeCrossfade();
      void this.maybePrepare();
      // A second look at the clock, at the first time reported while playing, in case the browser only shows the
      // song's time once it plays. Only where a stream's own time couldn't have got that far yet.
      if (this.clockChecked || this.audio.currentTime <= 0) return;
      this.clockChecked = true;
      if (!this.clockIsAbsolute && this.streamStart > 1 && this.audio.currentTime >= this.streamStart - 0.25) {
        this.clockIsAbsolute = true;
        this.browserClockIsAbsolute = true;
      }
    });
    on('playing', () => {
      this.finished = false;
      this.decks.duck(this.active, false);
      // The song coming in at a crossfade rises as the one before it falls away.
      if (this.fadeIn > 0) {
        this.decks.rampFade(this.active, 1, this.fadeIn);
        this.fadeIn = 0;
      }
    });
    on('seeked', () => this.decks.duck(this.active, false));
    on('ended', () => this.songEnded());
    on('error', () => {
      // The engine couldn't play the song (a browser that won't start its sound, a file it can't decode): the song
      // is played the ordinary way instead, from where it had got to.
      if (this.active === CAST_DECK) {
        this.set({ notice: `${this.snapshot.casting || 'The speaker or TV'} couldn't play that. It has to be on the same home network as the NAS.` });
        return;
      }
      if (this.active >= 2) {
        const song = this.current();
        if (song && !song.noEngine) {
          song.noEngine = true;
          void this.reloadCurrent(this.position(), true);
          return;
        }
      }
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
    // The song the listener left comes back with its queue, stopped where it was. A link to another song, or to a
    // moment in one, is followed as it is written.
    const saved = this.savedSession();
    const left = saved && route.kind === 'play' && route.at === 0 && trackIdOf(route.path) === saved.current;
    if (saved && left) void this.restoreSession(saved, true);
    else if (route.kind !== 'home') void this.applyRoute(route);
    else if (this.snapshot.pairing) void this.openFolder(loadLastPath());
    if (saved && route.kind !== 'play') void this.restoreSession(saved, false);
    if (this.snapshot.pairing) void this.loadLibrary();
    // Safari says when an AirPlay speaker is in reach; the bar then offers it.
    for (const element of this.decks.elements) element.setAttribute('x-webkit-airplay', 'allow');
    on('webkitplaybacktargetavailabilitychanged', (event) => {
      this.set({ canAirplay: (event as Event & { availability?: string }).availability === 'available' });
    });
    void this.restoreKept();
    this.offlineRead = this.loadOffline();
    void this.syncPlaylists().then(() => this.repointStored());
    void this.refreshUser();
    void this.loadShared();
    void this.loadListening();
    this.startLive();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      void this.syncPlaylists();
      void this.loadShared();
    });
    addEventListener('online', () => { void this.syncPlaylists(); void this.sendPendingPlays(); });
    // Where the listener is gets saved as they go, and when the page is put away.
    setInterval(() => { if (!this.audio.paused) this.saveSessionNow(); }, 5000);
    on('pause', () => this.saveSessionNow());
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
    // A song whose stream hasn't been loaded yet can't have ended: this is the song before it ending a second time
    // (a browser can say both that it paused at its end and that it ended), which would skip the new song.
    if (this.finished || !this.streamLoaded) return;
    // The song fading out under the next one ends: that is the crossfade's business, not a song to move on from.
    if (this.fading?.deck === this.active) return;
    this.finished = true;
    const { queue, currentId, repeat } = this.snapshot;
    const at = queue.findIndex((track) => track.id === currentId);
    if (repeat === 'one') {
      // The same song again, from its start: a new hearing of it.
      this.heard = 0;
      this.heardFrom = -1;
      this.playTold = false;
      this.resumeAfterSeek = true;
      this.seek(0);
      if (!this.exact) this.audio.play().catch(() => {});
    } else if (stepFrom(this.order, at, 1, repeat).index < 0) {
      this.set({ playing: false });
    } else {
      // A join the listener shaped may start the next song part-way in.
      this.startNextAt = this.handover()?.startAt ?? 0;
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
      // A link made before the song's album was replaced leads to the fresh copy.
      const pairing = this.snapshot.pairing;
      const fresh = (await fetchMoved(pairing, [trackIdOf(route.path)]).catch(() => null))?.[trackIdOf(route.path)];
      const freshPath = fresh ? pathOfTrackId(fresh) : null;
      if (freshPath && freshPath !== route.path) {
        await this.applyRoute({ kind: 'play', path: freshPath, at: route.at });
        if (this.snapshot.currentId === `nas:${fresh}`) this.writeRoute(this.playRoute(), 'replace');
        return;
      }
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
      this.set({ album: { path, state: 'ready', cover: folder.cover ?? null, tracks: folder.tracks.map((track) => trackFromNas(track, folder.cover ?? null)) }, playCounts: {} });
      if (this.snapshot.favourites) {
        void fetchPlayCounts(pairing, folder.tracks.map((track) => track.id)).then((playCounts) => { if (run === this.albumRun) this.set({ playCounts }); }).catch(() => {});
      }
    } catch (error) {
      if (run !== this.albumRun) return;
      // The NAS can't be reached: an album kept on this device opens from what was kept.
      const kept = this.snapshot.offline.sets.find((set) => set.key === albumKey(path));
      if (kept && !(error instanceof NasError && (error.status === 404 || error.status === 401))) {
        this.set({ album: { path, state: 'ready', cover: kept.cover, tracks: kept.tracks.map((track) => ({ ...fromSaved(track), ...(kept.cover ? { cover: kept.cover } : {}) })) }, playCounts: {} });
        return;
      }
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
    if (songsTab === 'queue' && !this.snapshot.currentTrack) songsTab = pairing ? 'folders' : 'device';
    if (songsTab === 'devices' && !this.snapshot.devices.length) songsTab = pairing ? 'folders' : 'device';
    if (songsTab === 'together' && !this.snapshot.live) songsTab = pairing ? 'folders' : 'device';
    if (songsTab !== 'queue' && songsTab !== 'devices' && songsTab !== 'together') {
      if (!pairing) songsTab = 'device';
      else if (songsTab === 'device' && !tracks.length) songsTab = 'folders';
    }
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
  /**
   * Takes in files picked on this device and keeps copies of them for the next visit. `restored` is given when the
   * files are those copies coming back: they are listed quietly, without opening a song or being kept again.
   */
  async addFiles(files: File[], quiet = false, restored: KeptFile[] | null = null): Promise<void> {
    if (!files.length) return;
    const { tracks: added, looseLyrics, skipped } = await sortFiles(files);
    // Copies coming back don't touch the song that is open: it may be one restored from the NAS.
    const current = restored ? null : this.current();
    let currentGotLyrics = false;
    const keep: KeptFile[] = added.flatMap((track) => [...(track.file ? [{ file: track.file }] : []), ...track.lyricFiles.map((file) => ({ file }))]);

    // Lyrics that match no audio in this batch go to a track already here with that name, else to the song that
    // is open, else to the first new track, else they wait for the next audio file.
    const unplaced: File[] = [];
    for (const file of looseLyrics) {
      // A kept lyrics file goes back to the song it was given to, whatever its name.
      const given = restored?.find((kept) => kept.file === file)?.owner;
      const owner = (given && [...added, ...this.snapshot.tracks].find((track) => track.fileName === given))
        || this.snapshot.tracks.find((track) => track.fileName && lyricsBelongTo(file.name, track.fileName));
      if (owner) {
        owner.lyricFiles.push(file);
        currentGotLyrics ||= owner === current;
        keep.push({ file });
      } else {
        unplaced.push(file);
      }
    }
    const target = current ?? added[0] ?? null;
    keep.push(...unplaced.map((file) => (target ? { file, owner: target.fileName } : { file })));
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
    if (restored) return;
    void keepFiles(keep).then((kept) => {
      if (!kept && added.length) this.set({ notice: "This browser has no room to keep those songs, so they are here for this visit only." });
    });
    if (!current && added.length) await this.select(added[0].id, false);
    else if (current && currentGotLyrics) await this.loadLyrics(current, ++this.loadRun);
  }

  /* ---------- Playing ---------- */

  /** Where a song's audio is, and how it is sought exactly when it can be (a FLAC file: by index here, by the NAS there). */
  private async audioFor(track: Track): Promise<{ url: string; exact: PlayerStore['exact'] }> {
    if (track.file) {
      let url = this.urls.get(track.id);
      if (!url) {
        url = URL.createObjectURL(track.file);
        this.urls.set(track.id, url);
      }
      // A FLAC file on the device gets its index read first (a few small reads), so that every seek is exact.
      const index = await readFlacIndex(fileReader(track.file), track.file.size).catch(() => null);
      return { url, exact: index ? { index, total: index.totalSamples / index.sampleRate } : null };
    }
    if (track.nas && this.snapshot.pairing) {
      const ticket = await fetchTicket(this.snapshot.pairing, track.nas.id);
      return { url: ticket.url, exact: ticket.exactSeek && ticket.totalSeconds ? { index: null, total: ticket.totalSeconds } : null };
    }
    throw new Error('no audio');
  }

  /**
   * Gets a song ready to play: its copy kept on this device opened, a stored song looked up again (or followed to
   * where it moved), and its audio found. Null when the NAS no longer has it.
   */
  private async resolve(track: Track): Promise<{ url: string; exact: PlayerStore['exact'] } | null> {
    // (What is kept is read when the page opens; a song restored at once waits that moment for it.)
    await this.offlineRead;
    // A song kept on this device plays from its copy, with or without the NAS.
    if (track.nas && !track.file && this.snapshot.offline.ids.includes(track.nas.id)) {
      const copy = await offlineTrack(track.nas.id);
      if (copy && !track.file) {
        track.file = new File([copy.blob], copy.name, { type: copy.blob.type });
        track.keptLyrics = copy.lyrics;
        track.stale = false;
      }
    }
    // A song from a playlist or a saved session is looked up again first: its lyrics files and cover may have changed.
    if (track.stale && !(await this.freshen(track)) && !(await this.followMove(track))) return null;
    return this.audioFor(track);
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
    // Where in the song to start: its beginning, unless a join the listener shaped says otherwise.
    const joinAt = this.startNextAt;
    this.startNextAt = 0;
    // Choosing a song of one's own ends listening along with someone else.
    if (this.snapshot.joined && !this.followingNow) void this.listenAlong(null);
    this.wantedStart = null;
    if (autoplay) this.decks.wake();
    // Choosing a song cuts short a crossfade that is under way, unless this is the crossfade's own next song.
    if (!this.handingOver) this.endFade();
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
    this.streamLoaded = false;
    this.heard = 0;
    this.heardFrom = -1;
    this.playTold = false;
    // The next song of an album may already be in place on the engine, set to begin on the frame this one ended on.
    const ready = this.prepared?.id === id ? this.prepared : null;
    if (!ready) this.cancelPrepared();
    // The song before goes quiet, unless it is fading out under this one or this one is already following it.
    if (!this.handingOver && !ready) this.audio.pause();
    // In the tap itself: a phone only lets a tap start the engine's sound.
    if (autoplay && this.engineOn() && track.sampleRate) this.decks.engine.prime(track.sampleRate);
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
    if (ready) {
      // Gapless: nothing is loaded or started. The deck the song is already on becomes the one the player follows.
      this.prepared = null;
      const before = this.active;
      this.active = ready.deck;
      if (before !== ready.deck) this.clearDeck(before);
      this.exact = ready.exact;
      if (this.exact) this.set({ duration: this.exact.total });
      this.applyVolume();
      this.streamLoaded = true;
      this.decks.wake();
      this.set({ playing: true });
      this.wireMediaSession();
      this.tellPosition();
      this.sayPlaying(true);
      await this.loadLyrics(track, run);
      return;
    }
    try {
      const audio = await this.resolve(track);
      if (run !== this.loadRun) return;
      if (!audio) {
        this.set({ lyricsLoading: false, notice: `The NAS doesn't have "${track.title}" any more.` });
        return;
      }
      if (track.nas) this.set({ duration: track.durationSeconds ?? 0 });
      this.exact = audio.exact;
      if (this.exact) this.set({ duration: this.exact.total });
      // The song goes on a deck of the kind it needs: the engine for a FLAC song when gapless playback is on, an
      // audio element otherwise. During a crossfade that is never the deck the song before is fading out on.
      let deck = this.freeDeck(this.wantsEngine(track, audio.exact));
      if (this.snapshot.casting && track.nas && this.snapshot.pairing) {
        // Casting: the speaker or TV fetches the song itself, from the NAS's address on the home network, and
        // moves within it by itself.
        const ticket = await fetchTicket(this.snapshot.pairing, track.nas.id, 0, true);
        if (run !== this.loadRun) return;
        audio.url = ticket.url;
        this.exact = null;
        deck = CAST_DECK;
        const shown = nowPlayingArt(this.snapshot.songInfo);
        this.decks.cast.describe({
          title: this.snapshot.songInfo?.trackName ?? track.title, artist: this.snapshot.songInfo?.artistName ?? track.artist, album: track.album,
          art: shown, fileName: pathOfTrackId(track.nas.id) ?? '',
        });
      } else if (this.snapshot.casting) {
        this.set({ notice: `${track.title} is on this device only, so it plays here, not on ${this.snapshot.casting}.` });
      }
      if (deck !== this.active) {
        if (this.fading?.deck !== this.active) this.clearDeck(this.active);
        this.active = deck;
      }
      if (this.fading && this.fadeIn > 0) this.decks.setFade(deck, 0);
      // By now a stored song has been looked up again, so how loud it is is known.
      this.applyVolume();
      // A seek made while the song was being fetched wins over where a shaped join would have started it.
      const startAt = this.wantedStart ?? joinAt;
      this.wantedStart = null;
      if (startAt > 0.5 && this.exact && startAt < this.exact.total - 2) {
        // Started part-way in, the way a seek is made exact: with a stream that begins there.
        this.streamLoaded = true;
        this.pendingSeek = startAt;
        this.resumeAfterSeek = autoplay;
        void this.restartAt(startAt);
      } else {
        this.audio.src = audio.url;
        this.streamLoaded = true;
        if (startAt > 0.5) {
          const element = this.audio;
          element.addEventListener('loadedmetadata', () => { if (run === this.loadRun) element.currentTime = startAt; }, { once: true });
        }
        if (this.pendingSeek !== null) this.pendingSeek = null;
        if (autoplay) this.audio.play().catch(() => {});
      }
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
    texts.push(...(track.keptLyrics ?? []));
    for (const file of track.nas && pairing && !track.keptLyrics ? track.nas.lyrics : []) {
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
    const opened: { source: LyricsSource; name: string; timed: boolean }[] = [];
    for (const item of texts) {
      try {
        const one = openLyrics(item.text, item.name);
        opened.push({ source: one, name: item.name, timed: songFromDoc(one.doc).timed });
      } catch {
        unreadable.push(item.name);
      }
    }
    // Lyrics that follow the song come before lyrics that are only words: with both beside a song, the timed ones show.
    const anyTimed = opened.some((item) => item.timed);
    for (const item of opened.filter((entry) => entry.timed || !anyTimed)) {
      if (!source) source = item.source;
      else if (sameSong(source, item.source)) mergeInto(source, item.source);
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
    // In the tap itself: a phone only lets a tap (or the lock screen) start sound.
    if (this.audio.paused) this.decks.wake();
    // A pause in the middle of a crossfade ends it: the song that was going is gone.
    else this.endFade();
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

  /* ---------- The queue, as the listener sees and arranges it ---------- */

  /** The songs still to come, in the order they will play. */
  upcoming(): Track[] {
    const { queue, currentId } = this.snapshot;
    const place = this.order.indexOf(queue.findIndex((track) => track.id === currentId));
    return place < 0 ? [] : this.order.slice(place + 1).map((index) => queue[index]);
  }

  /**
   * Arranges what is to come. The list is first put in the order it plays, so a shuffled queue keeps its shuffle
   * and the listener's changes sit in it exactly where they were made.
   */
  private arrange(change: (list: Track[], currentId: string) => Track[]): void {
    const { queue, currentId } = this.snapshot;
    if (!currentId) return;
    const list = inPlayOrder(queue, this.order);
    const next = change(list, currentId);
    this.cancelPrepared();
    this.order = next.map((_, index) => index);
    this.set({ queue: next });
    this.saveSessionNow();
  }

  /** Puts songs straight after the one that is playing, or at the end of the queue. With nothing playing, they play. */
  enqueue(tracks: Track[], next: boolean): void {
    if (!tracks.length) return;
    if (!this.snapshot.currentTrack) {
      void this.playFrom(tracks, { kind: 'queue' }, tracks[0].id);
      return;
    }
    const before = this.upcoming().length;
    this.arrange((list, currentId) => withQueued(list, currentId, tracks, next));
    const what = tracks.length === 1 ? tracks[0].title : `${tracks.length} songs`;
    const only = tracks.length === 1 && tracks[0].id === this.snapshot.currentId;
    this.set({ notice: only ? `${what} is playing now.` : next ? `${what} will play next.` : this.upcoming().length > before ? `Added ${what} to the queue.` : `Moved ${what} to the end of the queue.` });
  }

  /** The same for songs the NAS keeps for the listener: from a playlist, the favourites or the history. */
  enqueueSaved(songs: SavedTrack[], next: boolean): void { this.enqueue(songs.map(fromSaved), next); }

  moveInQueue(id: string, to: 'up' | 'down' | 'next'): void { this.arrange((list, currentId) => withMovedInQueue(list, currentId, id, to)); }
  removeFromQueue(id: string): void { this.arrange((list, currentId) => withoutQueued(list, currentId, id)); }
  clearUpcoming(): void { this.arrange((list, currentId) => withoutUpcoming(list, currentId)); }

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
    this.cancelPrepared();
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
    this.cancelPrepared();
    this.applyVolume();
  }

  private keepSettings(): void {
    const { showRoman, showTranslation, repeat, shuffle, sweepLines, seekOnLine, levelVolume, crossfade, gapless } = this.snapshot;
    saveSettings({ showRoman, showTranslation, repeat, shuffle, sweepLines, seekOnLine, levelVolume, crossfade, gapless });
  }

  /** Opens Safari's list of AirPlay speakers and screens. */
  chooseAirplay(): void {
    (this.audio as HTMLAudioElement & { webkitShowPlaybackTargetPicker?: () => void }).webkitShowPlaybackTargetPicker?.();
  }

  /** Brings back the songs kept in this browser from earlier visits. */
  private async restoreKept(): Promise<void> {
    const kept = await loadKept();
    if (kept.length) await this.addFiles(kept.map((entry) => entry.file), true, kept);
  }

  /** Forgets the songs picked on this device: the list, and the copies kept in the browser. The files themselves are untouched. */
  async forgetDeviceSongs(): Promise<void> {
    await forgetKept();
    this.waitingLyrics = [];
    if (this.snapshot.currentTrack && !this.snapshot.currentTrack.nas) {
      this.loadRun++;
      this.source = null;
      this.audio.pause();
      this.resetStream();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.set({
        tracks: [], queue: [], currentId: null, currentTrack: null, song: null, lyricsLoading: false, lyricsNames: [], songInfo: null, usInfo: null,
        duration: 0, view: 'library', page: { kind: 'home' },
      });
      this.order = [];
      this.writeRoute({ kind: 'home' }, 'replace');
      this.updateMediaSession();
    } else {
      this.set({ tracks: [], ...(this.snapshot.page.kind === 'deviceAlbum' ? { page: { kind: 'home' } as const } : {}) });
    }
  }

  /* ---------- Picking up where the listener left off ---------- */

  private saveSessionNow(): void {
    this.reportState();
    const { pairing, currentTrack, queue, source } = this.snapshot;
    // Only NAS songs can come back: a file picked on the device is gone once the page is.
    if (!pairing || !currentTrack?.nas || source.kind === 'device') return;
    saveSession({
      nas: pairing.base,
      source,
      tracks: queue.filter((track) => track.nas).map(savedOf),
      current: currentTrack.nas.id,
      position: this.restoringAt ?? (this.finished ? 0 : this.position()),
      // The order goes with it when every song is kept, so a queue arranged by hand comes back as it was.
      ...(queue.every((track) => track.nas) && this.order.length === queue.length ? { order: this.order } : {}),
    });
  }

  /** The session saved last time, if it was on the NAS this device is paired with. */
  private savedSession(): Session | null {
    const saved = loadSession();
    return saved && this.snapshot.pairing && saved.nas === this.snapshot.pairing.base ? saved : null;
  }

  /**
   * Puts the listener back where they were: the same queue, the same song, stopped at the same moment and waiting
   * for Play (a page can't start sound without a tap). `show` opens the song's lyrics; otherwise it only fills the bar.
   */
  private async restoreSession(saved: Session, show: boolean): Promise<void> {
    const queue = saved.tracks.map(fromSaved);
    const id = `nas:${saved.current}`;
    const index = queue.findIndex((track) => track.id === id);
    if (index < 0) return;
    // Until the song is back at its moment, what is saved stays as it was: a visit cut short mustn't forget the place.
    this.restoringAt = saved.position;
    try {
      this.setQueue(queue, saved.source, index);
      if (saved.order) this.order = saved.order;
      await this.select(id, false, show ? 'none' : 'replace');
      if (this.snapshot.currentId === id && this.audio.src && saved.position > 1) this.seek(saved.position);
    } finally {
      this.restoringAt = null;
    }
  }

  /**
   * For a stored song the NAS no longer has where it was: finds the fresh copy that replaced it (the NAS keeps a
   * record of albums that were replaced), makes the track that copy, and points the playlists at it too. False
   * when the song didn't move, or went with nothing in its place.
   */
  private async followMove(track: Track): Promise<boolean> {
    const pairing = this.snapshot.pairing;
    const old = track.nas?.id;
    if (!pairing || !track.nas || !old) return false;
    let fresh: string | null | undefined;
    try {
      fresh = (await fetchMoved(pairing, [old]))[old];
    } catch {
      return false;
    }
    if (!fresh) return false;
    const wasOpen = this.snapshot.currentId === track.id;
    track.nas = { ...track.nas, id: fresh };
    track.id = `nas:${fresh}`;
    if (!(await this.freshen(track))) return false;
    if (wasOpen && this.snapshot.currentTrack === track) {
      this.set({ currentId: track.id });
      if (this.snapshot.view === 'lyrics') this.writeRoute(this.playRoute(), 'replace');
      this.saveSessionNow();
    }
    this.repointPlaylists(new Map([[old, savedOf(track)]]));
    return true;
  }

  /** Replaces songs in the playlists by the copies they moved to. A playlist that already has the copy just loses the old one. */
  private repointPlaylists(moved: Map<string, SavedTrack>): void {
    let changed = false;
    const playlists = this.snapshot.playlists.map((playlist) => {
      if (!playlist.tracks.some((track) => moved.has(track.id))) return playlist;
      changed = true;
      const seen = new Set<string>();
      const tracks = playlist.tracks.map((track) => moved.get(track.id) ?? track).filter((track) => !seen.has(track.id) && seen.add(track.id));
      return { ...playlist, tracks };
    });
    if (changed) this.setPlaylists(playlists);
  }

  /**
   * Looks through the playlists for songs that have moved and points them at their fresh copies, so a playlist
   * made before an album was replaced lists and plays what is there now. Each album the songs moved to is read
   * once, for the songs' names as they are tagged now.
   */
  private async repointStored(): Promise<void> {
    const pairing = this.snapshot.pairing;
    if (!pairing) return;
    try {
      const ids = [...new Set(this.snapshot.playlists.flatMap((playlist) => playlist.tracks.map((track) => track.id)))];
      const answers = new Map<string, string>();
      for (let at = 0; at < ids.length; at += 5000) {
        for (const [old, fresh] of Object.entries(await fetchMoved(pairing, ids.slice(at, at + 5000)))) if (fresh) answers.set(fresh, old);
      }
      const folders = new Set([...answers.keys()].map((fresh) => folderOf(pathOfTrackId(fresh) ?? '')).filter(Boolean));
      const moved = new Map<string, SavedTrack>();
      for (const folder of folders) {
        const listing = await fetchFolder(pairing, folder).catch(() => null);
        for (const track of listing?.tracks ?? []) {
          const old = answers.get(track.id);
          if (old) moved.set(old, savedOf(trackFromNas(track)));
        }
      }
      if (this.snapshot.pairing === pairing && moved.size) this.repointPlaylists(moved);
    } catch {
      // The NAS can't be reached just now; the playlists are looked through again on the next visit.
    }
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
    const pairing = this.snapshot.pairing;
    // What was made, changed or deleted is noted, so the NAS can be told, now or on a later visit.
    if (pairing) savePlaylistSync(pairing.base, noteChanges(this.snapshot.playlists, playlists, loadPlaylistSync(pairing.base)));
    this.playlistEdits++;
    this.set({ playlists });
    if (pairing) savePlaylists(pairing.base, playlists);
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => void this.syncPlaylists(), 600);
  }

  /**
   * Brings this device's playlists and the NAS's together (see `reconcile`): the NAS's set is shared by every
   * paired device. Runs at the start of a visit, when the page comes back into view, and after a change here. A
   * NAS that can't be reached, or one from before it kept playlists, leaves them as they are on this device.
   */
  async syncPlaylists(): Promise<void> {
    const pairing = this.snapshot.pairing;
    if (!pairing || this.syncing) return;
    this.syncing = true;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const remote = await fetchPlaylists(pairing);
        if (this.snapshot.pairing !== pairing) return;
        if (!remote) {
          this.set({ playlistsShared: false });
          return;
        }
        const edits = this.playlistEdits;
        const merged = reconcile(this.snapshot.playlists, remote.playlists, loadPlaylistSync(pairing.base));
        let version = remote.version;
        if (merged.push) {
          const sent = await sendPlaylists(pairing, { base: remote.version, playlists: merged.playlists });
          if (this.snapshot.pairing !== pairing) return;
          // Another device changed them in between: look again.
          if (!sent) continue;
          version = sent.version;
        }
        // A change made here while this was under way stays noted, and goes round again.
        if (edits !== this.playlistEdits) {
          savePlaylistSync(pairing.base, { ...loadPlaylistSync(pairing.base), version });
          continue;
        }
        savePlaylistSync(pairing.base, { version, dirty: [], deleted: [] });
        savePlaylists(pairing.base, merged.playlists);
        const open = this.snapshot.openPlaylist;
        this.set({ playlists: merged.playlists, playlistsShared: true, ...(open && !merged.playlists.some((playlist) => playlist.id === open) ? { openPlaylist: null } : {}) });
        return;
      }
    } catch {
      // The NAS can't be reached just now. The playlists stay as they are here, and what changed stays noted.
    } finally {
      this.syncing = false;
    }
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

  removeFromPlaylist(id: string, index: number): void { this.changePlaylist(id, (playlist) => withoutLostTransitions(withoutTrack(playlist, index))); }
  moveInPlaylist(id: string, index: number, direction: 1 | -1): void { this.changePlaylist(id, (playlist) => withMoved(playlist, index, direction)); }
  renamePlaylist(id: string, name: string): void { this.changePlaylist(id, (playlist) => ({ ...playlist, name: cleanName(name) })); }

  deletePlaylist(id: string): void {
    this.setPlaylists(this.snapshot.playlists.filter((playlist) => playlist.id !== id));
    if (this.snapshot.openPlaylist === id) this.set({ openPlaylist: null });
    // Its songs kept on this device go with it.
    if (this.snapshot.offline.sets.some((set) => set.key === playlistKey(id))) void this.removeOffline(playlistKey(id));
  }

  showPlaylist(id: string | null): void { this.set({ openPlaylist: id, openShared: null }); }

  /** Shapes the join between two songs of one of the listener's playlists, or puts it back to the usual (null). */
  setTransition(id: string, from: string, to: string, transition: Transition | null): void {
    this.cancelPrepared();
    this.changePlaylist(id, (playlist) => {
      const { [transitionKey(from, to)]: _was, ...others } = playlist.transitions ?? {};
      const transitions = transition ? { ...others, [transitionKey(from, to)]: transition } : others;
      const { transitions: _all, ...rest } = playlist;
      return Object.keys(transitions).length ? { ...rest, transitions } : rest;
    });
  }

  /**
   * Plays a join as it would be with `transition`, before it is kept: the playlist from the first of the two
   * songs, starting a few seconds before the join. It stays in force until `stopTrying`.
   */
  async tryTransition(id: string, index: number, transition: Transition | null): Promise<void> {
    const playlist = this.snapshot.playlists.find((candidate) => candidate.id === id);
    const from = playlist?.tracks[index];
    const to = playlist?.tracks[index + 1];
    if (!playlist || !from || !to) return;
    // Trying "the usual" means the join without the shaping that is kept for it.
    this.trying = { key: transitionKey(from.id, to.id), transition: transition ?? this.usualJoin() };
    if (this.snapshot.shuffle) this.toggleShuffle();
    await this.playPlaylist(id, index);
    if (this.snapshot.currentId !== `nas:${from.id}`) return;
    const shaped = this.trying?.transition;
    const lead = (shaped?.leave ?? 0) + (shaped?.kind === 'fade' ? shaped.seconds : 0) + 6;
    const at = Math.max(0, this.snapshot.duration - lead);
    if (at > 1) {
      this.resumeAfterSeek = true;
      this.seek(at);
    }
  }

  /** The join as the settings under Options make it, as a transition. */
  private usualJoin(): Transition {
    const { crossfade } = this.snapshot;
    return crossfade ? { kind: 'fade', seconds: crossfade, leave: 0, startAt: 0 } : { kind: 'cut', seconds: 0, leave: 0, startAt: 0 };
  }

  stopTrying(): void {
    this.trying = null;
    this.cancelPrepared();
  }

  /** Says who but the owner may use a playlist: nobody, everyone to play it, or everyone to change it too. */
  setPlaylistAccess(id: string, access: PlaylistAccess): void {
    this.changePlaylist(id, ({ access: _was, ...playlist }) => (access === 'private' ? playlist : { ...playlist, access }));
  }

  /* ---------- NAS songs kept on this device (library/offline.ts) ---------- */

  /** Reads what is kept, and how much room it takes. */
  async loadOffline(): Promise<void> {
    const [{ sets, ids }, use] = await Promise.all([loadOffline(), storageUse()]);
    for (const url of this.keptCovers.values()) URL.revokeObjectURL(url);
    this.keptCovers.clear();
    const view = sets.map((set): KeptSet => {
      const cover = set.cover ? URL.createObjectURL(set.cover) : null;
      if (cover) this.keptCovers.set(set.key, cover);
      return { key: set.key, kind: set.kind, title: set.title, detail: set.detail, tracks: set.tracks, bytes: set.bytes, cover };
    });
    this.set({ offline: { ...this.snapshot.offline, sets: view, ids, use } });
  }

  /**
   * Keeps an album or a playlist on this device: each song's audio and lyrics are fetched and stored, one after
   * another, skipping songs already here. It can be stopped, and pressed again later to carry on.
   */
  async keepOffline(set: { key: string; kind: 'album' | 'playlist'; title: string; detail: string; cover?: string | null }, tracks: Track[]): Promise<void> {
    const pairing = this.snapshot.pairing;
    const songs = tracks.filter((track) => track.nas);
    if (!pairing || !songs.length) return;
    if (this.snapshot.offline.busy) {
      this.set({ notice: `Still keeping ${this.snapshot.offline.busy.title}. This one can be kept when that is done.` });
      return;
    }
    const run = ++this.keepRun;
    const progress = (done: number) => this.set({ offline: { ...this.snapshot.offline, busy: { key: set.key, title: set.title, done, total: songs.length } } });
    progress(0);
    const stored: SavedTrack[] = [];
    let bytes = 0;
    let problem = '';
    try {
      for (const [index, track] of songs.entries()) {
        if (run !== this.keepRun) break;
        const id = track.nas!.id;
        const had = this.snapshot.offline.ids.includes(id) ? await offlineTrack(id) : null;
        if (had) {
          bytes += had.bytes;
        } else {
          // A song from a playlist is looked up first: its lyrics files aren't known until its folder is read.
          if (track.stale && !(await this.freshen(track))) continue;
          const ticket = await fetchTicket(pairing, id);
          const response = await fetch(ticket.url);
          if (!response.ok) throw new Error('audio');
          const blob = await response.blob();
          const lyrics: { name: string; text: string }[] = [];
          for (const file of track.nas!.lyrics) lyrics.push({ name: file.name, text: await fetchLyrics(pairing, id, file.index) });
          if (run !== this.keepRun) break;
          await keepTrack({ id, name: (pathOfTrackId(id) ?? id).split('/').pop() ?? id, blob, lyrics, bytes: blob.size });
          bytes += blob.size;
          this.set({ offline: { ...this.snapshot.offline, ids: [...this.snapshot.offline.ids, id] } });
        }
        stored.push(savedOf(track));
        progress(index + 1);
      }
    } catch (error) {
      const full = error instanceof DOMException && (error.name === 'QuotaExceededError' || error.name === 'AbortError');
      problem = full ? `This device has no room for the rest of ${set.title}.` : `Couldn't keep all of ${set.title}. Press the button again to carry on.`;
    }
    // Stopped or cut short, the songs fetched so far are kept; pressing again carries on from there.
    if (stored.length) {
      let cover: Blob | null = null;
      try {
        if (set.cover) cover = await (await fetch(smallCover(set.cover))).blob();
      } catch {
        // The album is kept without its picture.
      }
      await keepSet({ key: set.key, kind: set.kind, title: set.title, detail: set.detail, tracks: stored, bytes, cover, keptAt: new Date().toISOString() }).catch(() => { problem ||= `Couldn't keep ${set.title} on this device.`; });
    }
    await removeStrays();
    if (this.getSnapshot().offline.busy?.key === set.key) this.set({ offline: { ...this.snapshot.offline, busy: null } });
    await this.loadOffline();
    if (problem) this.set({ notice: problem });
    else if (stored.length === songs.length) this.set({ notice: `${set.title} is on this device, and plays with no connection.` });
  }

  /** Keeps one of the listener's own playlists on this device. */
  async keepPlaylistOffline(id: string): Promise<void> {
    const playlist = this.snapshot.playlists.find((candidate) => candidate.id === id);
    if (playlist) await this.keepOffline({ key: playlistKey(id), kind: 'playlist', title: playlist.name, detail: '' }, playlist.tracks.map(fromSaved));
  }

  /** Stops keeping what is being kept. What was fetched so far stays. */
  stopKeeping(): void {
    this.keepRun++;
  }

  async removeOffline(key: string): Promise<void> {
    if (this.snapshot.offline.busy?.key === key) this.keepRun++;
    await removeSet(key).catch(() => {});
    await this.loadOffline();
  }

  /* ---------- Favourites and listening history (per user, on the NAS) ---------- */

  /** Reads the user's favourites and history, and sends any plays that couldn't be sent before. */
  async loadListening(): Promise<void> {
    const pairing = this.snapshot.pairing;
    if (!pairing) return;
    try {
      const favourites = await fetchFavourites(pairing);
      if (this.snapshot.pairing !== pairing) return;
      this.set({ favourites });
      if (!favourites) return;
      await this.sendPendingPlays();
      await this.loadHistory();
    } catch {
      // Read again on the next visit.
    }
  }

  async loadHistory(): Promise<void> {
    const pairing = this.snapshot.pairing;
    if (!pairing || !this.snapshot.favourites) return;
    try {
      const history = await fetchHistory(pairing);
      if (this.snapshot.pairing === pairing) this.set({ history });
    } catch {
      // What was shown stays.
    }
  }

  isFavouriteSong(id: string): boolean {
    return this.snapshot.favourites?.songs.some((song) => song.track.id === id) ?? false;
  }

  /** Marks a NAS song as a favourite or takes the mark away: shown at once, and put back if the NAS refuses. */
  async toggleFavouriteSong(song: Track | SavedTrack): Promise<void> {
    const pairing = this.snapshot.pairing;
    const before = this.snapshot.favourites;
    const track = 'origin' in song ? (song.nas ? savedOf(song) : null) : song;
    if (!pairing || !before || !track) return;
    const on = !before.songs.some((entry) => entry.track.id === track.id);
    this.set({ favourites: { ...before, songs: on ? [...before.songs, { track, addedAt: new Date().toISOString() }] : before.songs.filter((entry) => entry.track.id !== track.id) } });
    try {
      await setFavouriteSong(pairing, track, on);
    } catch {
      this.set({ favourites: before, notice: "Can't change your favourites just now. Try again in a moment." });
    }
  }

  async toggleFavouriteAlbum(album: { path: string; title: string; artist: string }): Promise<void> {
    const pairing = this.snapshot.pairing;
    const before = this.snapshot.favourites;
    if (!pairing || !before) return;
    const on = !before.albums.some((entry) => entry.path === album.path);
    this.set({ favourites: { ...before, albums: on ? [...before.albums, { ...album, addedAt: new Date().toISOString() }] : before.albums.filter((entry) => entry.path !== album.path) } });
    try {
      await setFavouriteAlbum(pairing, album, on);
    } catch {
      this.set({ favourites: before, notice: "Can't change your favourites just now. Try again in a moment." });
    }
  }

  /** Plays songs stored on the NAS for the user (favourites, history) as a queue, from the one at `index`. */
  async playSaved(tracks: SavedTrack[], source: QueueSource, index: number): Promise<void> {
    const list = tracks.map(fromSaved);
    await this.playFrom(list, source, list[index]?.id);
  }

  /**
   * Counts how much of the open song has really been heard: time that passed while it played, not time jumped
   * over. At half the song, or four minutes, the NAS is told once that the user played it.
   */
  private noteHeard(): void {
    const track = this.snapshot.currentTrack;
    if (this.audio.paused || !track?.nas || !this.snapshot.favourites || this.playTold) return;
    const at = this.position();
    const step = at - this.heardFrom;
    if (this.heardFrom >= 0 && step > 0 && step < 2) this.heard += step;
    this.heardFrom = at;
    const length = this.snapshot.duration;
    if (this.heard < (length > 0 ? Math.min(length / 2, 240) : 240)) return;
    this.playTold = true;
    const pairing = this.snapshot.pairing;
    if (!pairing) return;
    savePendingPlays(pairing.base, [...loadPendingPlays(pairing.base), { track: savedOf(track), at: new Date().toISOString() }]);
    void this.sendPendingPlays().then(() => this.loadHistory());
  }

  /** Sends the plays the NAS hasn't been told of. One that fails stays for the next try. */
  private async sendPendingPlays(): Promise<void> {
    const pairing = this.snapshot.pairing;
    if (!pairing || this.sendingPlays) return;
    this.sendingPlays = true;
    try {
      for (let pending = loadPendingPlays(pairing.base); pending.length; pending = loadPendingPlays(pairing.base)) {
        try {
          await reportPlay(pairing, pending[0].track, pending[0].at);
        } catch (error) {
          // A play the NAS won't take (not one it couldn't be reached for) is dropped, so it can't block the rest.
          if (!(error instanceof NasError) || error.status === 0 || error.status === 401 || error.status >= 500) return;
        }
        savePendingPlays(pairing.base, loadPendingPlays(pairing.base).slice(1));
      }
    } finally {
      this.sendingPlays = false;
    }
  }

  /* ---------- Remote control: the user's other devices (nas/live.ts) ---------- */

  /** Opens the live connection to the NAS, over which the user's devices see and steer each other. */
  private startLive(): void {
    this.stopLive?.();
    this.stopLive = null;
    const pairing = this.snapshot.pairing;
    if (!pairing) return;
    this.lastQueueTold = null;
    this.stopLive = openLive(pairing, (event) => {
      if (this.snapshot.pairing !== pairing) return;
      if (event.type === 'devices') {
        const fresh = this.myDevice !== event.you || !this.liveUp;
        this.myDevice = event.you;
        this.liveUp = true;
        this.set({ live: true, devices: event.devices.filter((device) => device.id !== event.you) });
        // Newly connected: the others are told what is playing here, queue and all.
        if (fresh) {
          this.lastQueueTold = null;
          this.reportState();
        }
      } else if (event.type === 'command') {
        this.obey(event.command);
      } else if (event.type === 'rooms') {
        const mine = event.rooms.find((room) => room.id === this.myDevice);
        const was = this.snapshot.joined;
        this.set({ rooms: event.rooms.filter((room) => room.id !== this.myDevice), sharing: mine !== undefined, listeners: mine?.listeners ?? 0, joined: event.joined });
        // The one this device was listening along with has stopped sharing: the music here carries on by itself.
        if (was && !event.joined && this.wasFollowing === was) this.set({ notice: 'They stopped sharing. Your music carries on from here.' });
        this.wasFollowing = event.joined;
      } else if (event.type === 'room') {
        void this.followRoom(event.room);
      }
    }, () => {
      this.liveUp = false;
      this.wasFollowing = null;
      if (this.snapshot.pairing === pairing) this.set({ live: false, devices: [], rooms: [], sharing: false, listeners: 0, joined: null });
    });
  }

  /**
   * Tells the user's other devices what is playing here: whether, where in the song, and the song; and the queue
   * when it has changed, in the order it plays, so that another device can take it over. Only songs from the NAS
   * can be told of; a song from this device means nothing elsewhere.
   */
  private reportState(): void {
    clearTimeout(this.reportTimer);
    this.reportTimer = window.setTimeout(() => {
      const { pairing, currentTrack, queue, duration } = this.snapshot;
      if (!pairing || !this.liveUp) return;
      const state: Partial<PlaybackState> = {
        playing: !this.audio.paused && !this.finished,
        position: this.position(),
        at: Date.now(),
        duration,
        track: currentTrack?.nas ? savedOf(currentTrack) : null,
      };
      if (this.lastQueueTold !== queue || this.lastOrderTold !== this.order) {
        this.lastQueueTold = queue;
        this.lastOrderTold = this.order;
        const songs = inPlayOrder(queue, this.order).filter((track) => track.nas).map(savedOf);
        // A very long queue is told from a little before the open song.
        const at = songs.findIndex((song) => song.id === currentTrack?.nas?.id);
        const from = songs.length > MAX_SHARED_QUEUE ? Math.max(0, Math.min(at - 20, songs.length - MAX_SHARED_QUEUE)) : 0;
        state.queue = songs.slice(from, from + MAX_SHARED_QUEUE);
        state.order = state.queue.map((_, index) => index);
      }
      sendState(pairing, state);
    }, 300);
  }

  /** Does what another of the user's devices asked. */
  private obey(command: RemoteCommand): void {
    if (!this.snapshot.currentId) return;
    if (command.action === 'play') { if (this.audio.paused) this.toggle(); }
    else if (command.action === 'pause') { if (!this.audio.paused) this.audio.pause(); }
    else if (command.action === 'next') this.step(1, !this.audio.paused);
    else if (command.action === 'previous') this.step(-1, !this.audio.paused);
    else if (command.action === 'seek' && command.value !== undefined) this.seek(command.value);
  }

  /** Asks another device to play, pause, step or move within its song. */
  async remote(deviceId: string, action: RemoteCommand['action'], value?: number): Promise<void> {
    const pairing = this.snapshot.pairing;
    if (!pairing) return;
    if (!(await sendCommand(pairing, deviceId, value === undefined ? { action } : { action, value }))) this.set({ notice: "That device isn't there any more." });
  }

  /** Where another device's song has got to by now, going by what it last said. */
  remotePosition(state: PlaybackState): number {
    const moved = state.playing ? Math.max(0, (Date.now() - state.at) / 1000) : 0;
    return Math.max(0, Math.min(state.position + moved, state.duration || state.position + moved));
  }

  /** Takes over what another device is playing: its queue and its place in the song come here, and it pauses. */
  async playHere(deviceId: string): Promise<void> {
    const device = this.snapshot.devices.find((candidate) => candidate.id === deviceId);
    const state = device?.state;
    if (!device || !state?.track || !state.queue?.length) {
      this.set({ notice: `${device?.name ?? 'That device'} has nothing playing that can be brought here.` });
      return;
    }
    const queue = state.queue.map(fromSaved);
    const id = `nas:${state.track.id}`;
    const index = queue.findIndex((track) => track.id === id);
    if (index < 0) return;
    void this.remote(deviceId, 'pause');
    this.setQueue(queue, { kind: 'queue' }, index);
    this.order = queue.map((_, place) => place);
    // Carries on from where it was there, less a moment for the handing over.
    const at = this.remotePosition(state);
    this.startNextAt = at > 3 && at < (state.duration || Infinity) - 3 ? at - 1 : 0;
    await this.select(id, true, 'push');
  }

  /* ---------- Listening together ---------- */

  /** Starts letting everyone on the NAS listen along with what this device plays, or stops. */
  async shareListening(on: boolean): Promise<void> {
    const pairing = this.snapshot.pairing;
    if (!pairing) return;
    if (!(await shareRoom(pairing, on))) {
      this.set({ notice: "Can't reach the NAS to change that. Try again in a moment." });
      return;
    }
    // Those who join are told the song and its place straight away.
    if (on) this.reportState();
  }

  /** Listens along with someone who is sharing, or (null) stops and carries on alone. */
  async listenAlong(roomId: string | null): Promise<void> {
    const pairing = this.snapshot.pairing;
    const leaving = roomId === null ? this.snapshot.joined : null;
    if (!pairing || (roomId === null && !leaving)) return;
    // In the tap: a phone only lets a tap start sound, and the song arrives a moment later.
    if (roomId) this.decks.wake();
    if (!(await joinRoom(pairing, roomId ?? leaving!, roomId !== null))) this.set({ notice: roomId ? "They aren't sharing any more." : "Can't reach the NAS to change that. Try again in a moment." });
  }

  /**
   * Follows the one this device is listening along with: their song, whether it is playing, and its place. The
   * place is reckoned by the server's clock (when it heard them, and now), so the two devices' own clocks needn't
   * agree. A second or so apart is let be; more than that is put right by moving in the song.
   */
  private async followRoom(room: RoomState): Promise<void> {
    if (this.snapshot.joined !== room.id) return;
    const { state } = room;
    const target = state.position + (state.playing ? Math.max(0, room.now - room.heardAt) / 1000 : 0);
    if (!state.track) {
      if (!this.audio.paused) this.audio.pause();
      return;
    }
    const id = `nas:${state.track.id}`;
    if (this.snapshot.currentId !== id) {
      const track = fromSaved(state.track);
      this.followingNow = true;
      try {
        this.setQueue([track], { kind: 'queue' }, 0);
        // A little ahead of where they are, for the time the song takes to arrive.
        this.startNextAt = state.playing ? target + 0.5 : target;
        await this.select(id, state.playing, 'replace');
      } finally {
        this.followingNow = false;
      }
      return;
    }
    if (this.pendingSeek !== null || this.restarting || !this.streamLoaded) return;
    if (state.playing && this.audio.paused) {
      this.decks.wake();
      this.audio.play().catch(() => {});
    } else if (!state.playing && !this.audio.paused) {
      this.audio.pause();
    }
    if (Math.abs(this.position() - target) > 1.2) this.seek(state.playing ? target + 0.3 : target);
  }

  /* ---------- Users, and the playlists they share ---------- */

  /** Asks the NAS whose device this is; the name may have changed since pairing. */
  private async refreshUser(): Promise<void> {
    const pairing = this.snapshot.pairing;
    if (!pairing) return;
    try {
      const user = await fetchUser(pairing);
      if (this.snapshot.pairing !== pairing || !user) return;
      if (user.id === pairing.user?.id && user.name === pairing.user.name) return;
      const next = { ...pairing, user };
      savePairing(next);
      this.set({ pairing: next, user });
    } catch (error) {
      if (error instanceof NasError && error.status === 401) this.nasFailed(error, '');
    }
  }

  /** Reads the playlists other users share. Left as they were when the NAS can't be reached. */
  async loadShared(): Promise<void> {
    const pairing = this.snapshot.pairing;
    if (!pairing) return;
    try {
      const sharedPlaylists = await fetchSharedPlaylists(pairing);
      if (this.snapshot.pairing !== pairing) return;
      const open = this.snapshot.openShared;
      this.set({ sharedPlaylists, ...(open && !sharedPlaylists.some((playlist) => sharedKey(playlist) === open) ? { openShared: null } : {}) });
    } catch {
      // Shown again the next time the page comes into view.
    }
  }

  showShared(key: string | null): void { this.set({ openShared: key, openPlaylist: null }); }

  private shared(key: string): SharedPlaylist | undefined {
    return this.snapshot.sharedPlaylists.find((playlist) => sharedKey(playlist) === key);
  }

  async playShared(key: string, index?: number): Promise<void> {
    const playlist = this.shared(key);
    if (!playlist?.tracks.length) return;
    const list = playlist.tracks.map(fromSaved);
    await this.playFrom(list, { kind: 'playlist', id: key }, index === undefined ? undefined : list[index]?.id);
  }

  /** Changes the songs of someone's collaborative playlist: shown at once, sent to the NAS, and put back if it refuses. */
  private async changeShared(key: string, change: (playlist: Playlist) => Playlist): Promise<boolean> {
    const pairing = this.snapshot.pairing;
    const playlist = this.shared(key);
    if (!pairing || !playlist || playlist.access !== 'collaborative') return false;
    const tracks = change(playlist).tracks;
    if (tracks === playlist.tracks) return true;
    const put = (next: SharedPlaylist) => this.set({ sharedPlaylists: this.snapshot.sharedPlaylists.map((candidate) => (sharedKey(candidate) === key ? next : candidate)) });
    put({ ...playlist, tracks });
    try {
      put(await sendSharedTracks(pairing, playlist.owner.id, playlist.id, tracks));
      return true;
    } catch (error) {
      put(playlist);
      void this.loadShared();
      this.set({ notice: error instanceof NasError && (error.status === 403 || error.status === 404) ? `${playlist.owner.name} no longer lets others change ${playlist.name}.` : `Can't change ${playlist.name} just now. Try again in a moment.` });
      return false;
    }
  }

  async addToShared(key: string, tracks: Track[]): Promise<void> {
    const playlist = this.shared(key);
    if (!playlist) return;
    const next = withTracks(playlist, tracks.filter((track) => track.nas).map(savedOf));
    const added = next.tracks.length - playlist.tracks.length;
    if (!added) {
      this.set({ notice: `${tracks.length === 1 ? 'That song is' : 'Those songs are'} already in ${playlist.name}.` });
      return;
    }
    if (await this.changeShared(key, () => next)) this.set({ notice: `Added ${added} ${added === 1 ? 'song' : 'songs'} to ${playlist.name}.` });
  }

  removeFromShared(key: string, index: number): void { void this.changeShared(key, (playlist) => withoutTrack(playlist, index)); }
  moveInShared(key: string, index: number, direction: 1 | -1): void { void this.changeShared(key, (playlist) => withMoved(playlist, index, direction)); }

  /** Makes an invite for another device of this user, to show as a link. */
  async makeDeviceInvite(): Promise<void> {
    const pairing = this.snapshot.pairing;
    if (!pairing) return;
    try {
      this.set({ deviceInvite: await makeInvite(pairing) });
    } catch (error) {
      this.set({ notice: error instanceof NasError && error.status === 429 ? 'That is enough invites for now. Try again in ten minutes.' : "Can't make an invite just now. Try again in a moment." });
    }
  }

  closeDeviceInvite(): void { this.set({ deviceInvite: null }); }

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
    // Through the mixer the song goes quiet for the jump: some browsers go on sounding the old moment while they look.
    this.endFade();
    this.cancelPrepared();
    // The song is still being fetched: it will start at the moment asked for (see `select`).
    if (!this.streamLoaded) {
      this.wantedStart = target;
      this.pendingSeek = target;
      this.tellPosition();
      return;
    }
    if (!this.audio.paused && (this.decks.mixer || this.active >= 2)) this.decks.duck(this.active, true);
    if (!this.exact) {
      this.audio.currentTime = target;
      return;
    }
    // Show the time asked for at once, and restart the stream a moment later: dragging the seek bar asks many times.
    this.pendingSeek = target;
    this.tellPosition();
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
          url = (await this.audioFor(track)).url;
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

    // Play pressed while the new stream was being asked for counts too: the listener wants sound when it arrives.
    const resume = this.resumeAfterSeek || !this.audio.paused;
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
      this.tellPosition();
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
    for (const player of this.decks.players) player.muted = false;
    try {
      localStorage.setItem(VOLUME_KEY, String(level));
    } catch {
      // Without storage the volume lasts until the tab closes.
    }
    this.set({ volume: level, muted: false });
    this.applyVolume();
  }

  toggleMute(): void {
    const muted = !this.snapshot.muted;
    for (const player of this.decks.players) player.muted = muted;
    // Unmuting a volume of nothing would still be silent.
    if (!muted && this.snapshot.volume === 0) this.setVolume(0.5);
    else this.set({ muted });
  }

  setShowRoman(showRoman: boolean): void { this.set({ showRoman }); this.keepSettings(); }
  setShowTranslation(showTranslation: boolean): void { this.set({ showTranslation }); this.keepSettings(); }
  setSweepLines(sweepLines: boolean): void { this.set({ sweepLines }); this.keepSettings(); }
  setSeekOnLine(seekOnLine: boolean): void { this.set({ seekOnLine }); this.keepSettings(); }
  setLevelVolume(levelVolume: boolean): void { this.set({ levelVolume }); this.keepSettings(); this.applyVolume(); }

  /**
   * How loud a song is to come out on a deck. Where a page can't set the volume, levelling is the mixer's switch.
   * The mixer and the engine can turn a quiet song up as well as a loud one down (never past its peak, and at most
   * double); an element's own volume can only turn it down.
   */
  private levelOf(track: Track, deck: number, album: boolean): number {
    const { canSetVolume, levelVolume, mixing } = this.snapshot;
    if (!(canSetVolume ? levelVolume : mixing)) return 1;
    return levelFactor(track, album, deck >= 2 || (this.decks.mixer && this.snapshot.mixing) ? 2 : 1);
  }

  /* ---------- Casting (cast.ts) ---------- */

  /**
   * Asks which speaker or TV to cast to, and moves the open song there, at the moment it has got to. From then on
   * songs from the NAS play on that device, with this page as the remote, until casting is stopped.
   */
  async startCast(): Promise<void> {
    if (!this.snapshot.pairing) {
      this.set({ notice: 'Casting plays songs from a NAS. Pair with one first.' });
      return;
    }
    const at = this.position();
    const playing = !this.audio.paused;
    this.decks.cast.onEnded = () => {
      // Stopped from the device, or by another remote: the song comes back here, paused where it was.
      const reached = this.position();
      this.set({ casting: '' });
      void this.reloadCurrent(reached, false);
    };
    const device = await this.decks.cast.connect(CAST_APP_ID);
    if (!device) return;
    this.endFade();
    this.cancelPrepared();
    this.set({ casting: device });
    await this.reloadCurrent(at, playing || this.snapshot.currentId === null);
  }

  /** Stops casting: the open song carries on from this device, paused where it was. */
  async stopCast(): Promise<void> {
    if (!this.snapshot.casting) return;
    const at = this.position();
    this.set({ casting: '' });
    this.decks.cast.disconnect();
    await this.reloadCurrent(at, false);
  }

  /* ---------- Decks, and gapless playback on the engine ---------- */

  /** Whether the engine may be used here: the listener asked for gapless playback, and the browser can do it. */
  private engineOn(): boolean {
    const { gapless, canGapless, canSetVolume, mixing } = this.snapshot;
    return gapless && canGapless && (canSetVolume || mixing);
  }

  /** Whether a song goes on the engine: a FLAC song that is sought by playing a new stream, when the engine is on. */
  private wantsEngine(track: Track, exact: PlayerStore['exact']): boolean {
    if (!this.engineOn() || !exact || track.noEngine) return false;
    const name = track.file?.name || track.fileName || (track.nas ? pathOfTrackId(track.nas.id) ?? '' : '');
    return /\.flac$/i.test(name);
  }

  /** A deck of the kind wanted that nothing is on: the one in use if it will do, never one a song is fading out on. */
  private freeDeck(engine: boolean): number {
    const kind = engine ? [2, 3] : [0, 1];
    const busy = new Set([this.fading?.deck, this.prepared?.deck]);
    if (kind.includes(this.active) && !busy.has(this.active)) return this.active;
    return kind.find((deck) => !busy.has(deck)) ?? kind[0];
  }

  /** Empties a deck: whatever was on it stops, and is let go. */
  private clearDeck(deck: number): void {
    const player = this.decks.players[deck];
    player.pause();
    player.removeAttribute('src');
    player.load();
  }

  /** Loads the open song again and carries on from `at`: after the way it is played has changed under it. */
  private async reloadCurrent(at: number, playing: boolean): Promise<void> {
    const { currentId } = this.snapshot;
    if (!currentId) return;
    await this.select(currentId, false, 'replace');
    if (this.snapshot.currentId !== currentId) return;
    if (at > 1) {
      this.resumeAfterSeek = playing;
      this.seek(at);
      if (this.exact) return;
    }
    if (playing) this.audio.play().catch(() => {});
  }

  /**
   * Gapless playback. When the open song is on the engine and has under twenty seconds left, the song that follows
   * it is got ready on the engine's other deck and told to begin on the very frame this one ends on. When this one
   * ends, `select` finds it there already sounding. Only where the two simply follow each other: not when a
   * crossfade will blend them, and not when what comes next isn't settled (a shuffled queue coming round again).
   */
  private async maybePrepare(): Promise<void> {
    const { duration, repeat, source, shuffle, queue, currentId } = this.snapshot;
    if (this.active === CAST_DECK) return;
    if (this.active < 2 || this.prepared || this.preparing || this.fading || this.audio.paused || this.pendingSeek !== null || this.restarting) return;
    const left = duration - this.position();
    if (left > 20 || left < 1.5) return;
    const plan = this.handover();
    if (!plan || !plan.plain || !plan.settled) return;
    const track = queue[stepFrom(this.order, queue.findIndex((candidate) => candidate.id === currentId), 1, repeat).index];
    const run = ++this.prepareRun;
    this.preparing = true;
    try {
      const audio = await this.resolve(track);
      if (run !== this.prepareRun || this.snapshot.currentId !== currentId || this.active < 2) return;
      if (!audio || !this.wantsEngine(track, audio.exact)) return;
      const deck = this.active === 2 ? 3 : 2;
      const player = this.decks.engines[deck - 2];
      this.decks.setFade(deck, 1);
      this.decks.setLevel(deck, this.levelOf(track, deck, source.kind === 'folder' && !shuffle));
      player.src = audio.url;
      player.follow(this.decks.engines[this.active - 2]);
      this.prepared = { id: track.id, deck, exact: audio.exact };
    } catch {
      // The next song will be opened the ordinary way when this one ends.
    } finally {
      if (run === this.prepareRun) this.preparing = false;
    }
  }

  /** Lets go of a song that was got ready to follow the open one: what comes next has changed. */
  private cancelPrepared(): void {
    this.prepareRun++;
    this.preparing = false;
    if (!this.prepared) return;
    this.clearDeck(this.prepared.deck);
    this.prepared = null;
  }

  setGapless(gapless: boolean): void {
    this.set({ gapless });
    this.keepSettings();
    this.cancelPrepared();
    // A song that is playing moves to the engine, or off it, at once.
    if (this.snapshot.currentId && this.audio.src) void this.reloadCurrent(this.position(), !this.audio.paused);
  }

  /* ---------- Crossfade ---------- */

  /**
   * How the open song hands over to the one after it: a crossfade of `fade` seconds (0 for none), begun `leave`
   * seconds before the song's end, the next song starting `startAt` seconds in. `plain` is a simple join at the
   * song's own end, the kind gapless playback can make exact. The listener's own shaping of that join in a
   * playlist (a `Transition`) comes first; otherwise it is the crossfade set under Options, which leaves alone the
   * songs of an album played in order, and songs too short to give up that much of themselves. Null when nothing
   * follows.
   */
  private handover(): { fade: number; leave: number; startAt: number; plain: boolean; settled: boolean } | null {
    const { crossfade, duration, repeat, source, shuffle, canSetVolume, mixing, queue, currentId } = this.snapshot;
    if (repeat === 'one') return null;
    const at = queue.findIndex((track) => track.id === currentId);
    const next = stepFrom(this.order, at, 1, repeat);
    if (next.index < 0) return null;
    const canFade = canSetVolume || mixing;
    // A shuffled queue coming round again is shuffled afresh: which song is next isn't known until then.
    const settled = !(next.wrapped && shuffle);
    const shaped = settled ? this.shapedJoin(queue[at], queue[next.index]) : null;
    if (shaped) {
      const fade = shaped.kind === 'fade' && canFade ? Math.min(shaped.seconds, Math.max(0, duration - shaped.leave - 2)) : 0;
      return { fade, leave: Math.min(shaped.leave, Math.max(0, duration - 2)), startAt: shaped.startAt, plain: fade === 0 && !shaped.leave && !shaped.startAt, settled };
    }
    const album = source.kind === 'folder' && !shuffle;
    const fade = crossfade && canFade && !album && duration > crossfade * 2 + 10 ? crossfade : 0;
    return { fade, leave: 0, startAt: 0, plain: fade === 0, settled };
  }

  /** The listener's own shaping of the join between two songs: one being tried out, or one kept in the playlist that is playing in order. */
  private shapedJoin(from: Track | undefined, to: Track | undefined): Transition | null {
    if (!from?.nas || !to?.nas) return null;
    const key = transitionKey(from.nas.id, to.nas.id);
    if (this.trying?.key === key) return this.trying.transition;
    const { source, shuffle, playlists, sharedPlaylists } = this.snapshot;
    if (source.kind !== 'playlist' || shuffle) return null;
    const playlist = playlists.find((candidate) => candidate.id === source.id) ?? sharedPlaylists.find((candidate) => sharedKey(candidate) === source.id);
    return playlist?.transitions?.[key] ?? null;
  }

  /**
   * Hands over to the next song when it is time: starts a crossfade when the song has that long left (the next
   * song begins on another deck and rises while this one falls away), or, for a join the listener shaped to leave
   * this song before its end without a fade, cuts to the next one at that moment.
   */
  private maybeCrossfade(): void {
    // A cast device plays one song at a time, at its own loudness: nothing is faded there.
    if (this.active === CAST_DECK) return;
    if (this.fading || this.handingOver || this.audio.paused || this.pendingSeek !== null || this.restarting || this.finished) return;
    const plan = this.handover();
    if (!plan || plan.plain) return;
    const left = this.snapshot.duration - plan.leave - this.position();
    if (plan.fade <= 0) {
      // No fade. A join at the song's own end is the ending's business (`songEnded`); one before it is made here.
      if (plan.leave <= 0 || left > 0.05) return;
      this.cancelPrepared();
      this.finished = true;
      this.startNextAt = plan.startAt;
      this.step(1, true);
      return;
    }
    if (left > plan.fade || left < 0.4) return;

    // This deck goes on playing the song out, fading; the next song is put on another (see `select`).
    this.cancelPrepared();
    const deck = this.active;
    this.decks.rampFade(deck, 0, left);
    this.fading = { element: this.decks.players[deck], deck, cutUrl: this.cutUrl, timer: window.setTimeout(() => this.endFade(), (left + 1) * 1000) };
    this.cutUrl = '';
    this.fadeIn = left;
    this.startNextAt = plan.startAt;
    this.handingOver = true;
    try {
      this.step(1, true);
    } finally {
      this.handingOver = false;
    }
  }

  /** Ends a crossfade: the song that was fading out is stopped and its deck made ready for the next one. */
  private endFade(): void {
    const fading = this.fading;
    if (!fading) return;
    this.fading = null;
    clearTimeout(fading.timer);
    this.clearDeck(fading.deck);
    if (fading.cutUrl) URL.revokeObjectURL(fading.cutUrl);
    this.decks.setFade(fading.deck, 1);
    // The song that came in is at full strength from here, however far its own fade had got.
    this.fadeIn = 0;
    this.decks.setFade(this.active, 1);
  }

  setCrossfade(seconds: number): void {
    this.cancelPrepared();
    this.set({ crossfade: Math.max(0, Math.min(12, Math.round(seconds))) });
    this.keepSettings();
    if (!this.snapshot.crossfade) this.endFade();
  }

  /** Takes the audio element into the mixer. Done once; from then on its sound comes out through the mixer. */
  private startMixer(): void {
    if (this.decks.mixer) return;
    try {
      this.decks.startMixer();
      // The phone pausing the speaker (a call, another app's sound) pauses the song with it.
      this.decks.mixer!.speaker.addEventListener('pause', () => { if (!this.audio.paused && !this.restarting) this.audio.pause(); });
      this.set({ mixing: true });
    } catch {
      this.set({ mixing: false, canMix: false });
    }
  }

  /**
   * Turns volume levelling through the mixer on or off, where a page can't set the volume itself (a phone). Turned
   * on in a tap, it takes effect at once: the open song is loaded again, since the mixer can't hear audio that was
   * asked for before it was there. Turned off, songs play as they are; the mixer itself stays until the next visit.
   */
  async setMixing(on: boolean): Promise<void> {
    keepMixerWanted(on);
    if (!on) {
      this.set({ mixing: false });
      this.applyVolume();
      return;
    }
    const fresh = !this.decks.mixer;
    this.startMixer();
    if (!this.decks.mixer) {
      this.set({ notice: "This browser can't level the volume." });
      return;
    }
    this.set({ mixing: true });
    this.decks.wake();
    const { currentId } = this.snapshot;
    if (fresh && currentId && this.audio.src) {
      await this.reloadCurrent(this.position(), !this.audio.paused);
    } else {
      this.applyVolume();
    }
  }

  /** Tells the lock screen whether the song is playing: through the mixer, the phone can't tell by itself. */
  private sayPlaying(playing: boolean): void {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  /**
   * Sets the audio element's volume: the listener's, times what brings the open song to the common loudness. An
   * album played through in order keeps its own quiet and loud songs. The element can only be turned down, and on
   * a phone a page can't set it at all, so there this does nothing.
   */
  private applyVolume(): void {
    const { volume, currentTrack, source, shuffle } = this.snapshot;
    const album = source.kind === 'folder' && !shuffle;
    this.decks.setVolume(volume);
    this.decks.setLevel(this.active, currentTrack ? this.levelOf(currentTrack, this.active, album) : 1);
  }
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
      this.stopLive?.();
      this.stopLive = null;
      this.liveUp = false;
      this.set({
        pairing: null, nasState: 'idle', nasFolder: null, playlists: [], openPlaylist: null, playlistsShared: false, user: null, sharedPlaylists: [], openShared: null, deviceInvite: null, favourites: null, history: null, playCounts: {}, devices: [], live: false, rooms: [], sharing: false, listeners: 0, joined: null, songsTab: 'device',
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
      this.set({ pairing, pendingPair: null, pairError: '', nasFolder: null, playlists: loadPlaylists(pairing.base), openPlaylist: null, user: pairing.user ?? null, sharedPlaylists: [], openShared: null, deviceInvite: null, favourites: null, history: null, playCounts: {}, songsTab: 'folders' });
      void this.syncPlaylists().then(() => this.repointStored());
      void this.loadShared();
      void this.loadListening();
      this.startLive();
      void this.loadLibrary();
      await this.openFolder('');
    } catch (error) {
      this.set({ pairError: (error instanceof NasError && NAS_MESSAGES[error.code]) || "Pairing didn't finish. Check the address and try again." });
    }
  }

  async forgetNas(): Promise<void> {
    const pairing = this.snapshot.pairing;
    if (!pairing) return;
    this.stopLive?.();
    this.stopLive = null;
    this.liveUp = false;
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
      pairing: null, nasState: 'idle', nasFolder: null, playlists: [], openPlaylist: null, playlistsShared: false, user: null, sharedPlaylists: [], openShared: null, deviceInvite: null, favourites: null, history: null, playCounts: {}, devices: [], live: false, rooms: [], sharing: false, listeners: 0, joined: null, songsTab: 'device',
      library: { state: 'idle', albums: [], scanning: false }, album: null, page: { kind: 'home' }, searchTracks: [], view: 'library',
      ...(playingFromNas ? { currentId: null, currentTrack: null, queue: [], song: null, lyricsNames: [], songInfo: null, usInfo: null } : {}),
    });
    this.writeRoute({ kind: 'home' }, 'replace');
    await forget(pairing);
  }

  /* ---------- Lock screen and media keys ---------- */

  private wireMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    // Previous and Next, not skipping by seconds: iOS shows one pair or the other, and the skip pair wins if claimed.
    const handlers: [MediaSessionAction, MediaSessionActionHandler | null][] = [
      ['seekbackward', null],
      ['seekforward', null],
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

  /**
   * Tells the lock screen where the song is and how long it is. Left to itself it reads the audio element, and
   * after an exact seek the element holds a stream that starts mid-song: its clock begins again at 0 and its
   * length is only what remains, so the lock screen's bar would jump back to the start.
   */
  private tellPosition(): void {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    this.positionTold = Date.now();
    const duration = this.snapshot.duration;
    try {
      if (!this.snapshot.currentId || !Number.isFinite(duration) || duration <= 0) navigator.mediaSession.setPositionState();
      else navigator.mediaSession.setPositionState({ duration, position: Math.max(0, Math.min(this.position(), duration)), playbackRate: 1 });
    } catch {
      // A browser that refuses the numbers keeps its own reading.
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
            ? [{ src: smallCover(track.cover) }]
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
/** What names a shared playlist: whose it is, and which of theirs. */
export const sharedKey = (playlist: SharedPlaylist): string => `${playlist.owner.id}/${playlist.id}`;

/** The id of a Cast receiver app of Taiko's own, when the site was built with one; '' for Google's standard receiver. */
const CAST_APP_ID: string = (import.meta.env as Record<string, string | undefined>).VITE_CAST_APP_ID ?? '';

/** A picture for the cast device's screen: Apple's, which any device can fetch (the NAS's cover is on a private address). */
const nowPlayingArt = (info: { artworkUrl100?: string } | null): string => info?.artworkUrl100?.replace('100x100', '600x600') ?? '';

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
