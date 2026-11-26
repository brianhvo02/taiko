/**
 * Casting to a Google Cast speaker or TV. The song plays there, fetched by that device itself from the NAS's
 * address on the home network; this page is the remote. Google's Cast code is loaded from Google only when the
 * listener asks to cast, never before.
 *
 * `CastPlayer` looks enough like an audio element for the player's store to drive it as it drives the others
 * (mixer.ts, engine.ts): `src`, `play()`, `pause()`, `currentTime` (set to move within the song: the cast device
 * seeks by itself), and the events the store listens for.
 *
 * None of this could be run against a real Cast device where it was written. It follows Google's documented
 * sender API (CastContext, RemotePlayer, RemotePlayerController), and the tests drive it with a stand-in.
 */

/* The parts of Google's sender API that are used, as far as they are relied on. */
interface CastMedia {
  idleReason: string | null;
  addUpdateListener(listener: (alive: boolean) => void): void;
}
interface CastSession {
  loadMedia(request: unknown): Promise<unknown>;
  getCastDevice(): { friendlyName: string };
  getMediaSession(): CastMedia | null;
  endSession(stopCasting: boolean): void;
}
interface CastContext {
  setOptions(options: Record<string, unknown>): void;
  requestSession(): Promise<unknown>;
  getCurrentSession(): CastSession | null;
  addEventListener(type: string, listener: (event: { sessionState: string }) => void): void;
}
interface RemotePlayer {
  isPaused: boolean;
  currentTime: number;
  duration: number;
  isMediaLoaded: boolean;
  playerState: string | null;
}
interface RemoteController {
  addEventListener(type: string, listener: (event: { field: string; value: unknown }) => void): void;
  playOrPause(): void;
  seek(): void;
  stop(): void;
}
interface CastGlobals {
  cast: {
    framework: {
      CastContext: { getInstance(): CastContext };
      CastContextEventType: { SESSION_STATE_CHANGED: string };
      SessionState: { SESSION_STARTED: string; SESSION_RESUMED: string; SESSION_ENDED: string };
      RemotePlayer: new () => RemotePlayer;
      RemotePlayerController: new (player: RemotePlayer) => RemoteController;
      RemotePlayerEventType: { ANY_CHANGE: string };
    };
  };
  chrome: {
    cast: {
      AutoJoinPolicy: { ORIGIN_SCOPED: string };
      Image: new (url: string) => unknown;
      media: {
        DEFAULT_MEDIA_RECEIVER_APP_ID: string;
        IdleReason: { FINISHED: string };
        MediaInfo: new (url: string, contentType: string) => { metadata: unknown; customData?: unknown };
        MusicTrackMediaMetadata: new () => { title?: string; artist?: string; albumName?: string; images?: unknown[] };
        LoadRequest: new (media: unknown) => { currentTime: number; autoplay: boolean };
      };
    };
  };
}
const globals = (): CastGlobals => window as unknown as CastGlobals;

const SENDER = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';

/** Whether this browser can cast at all: Chrome and Edge, not on an iPhone or iPad. */
export function castPossible(): boolean {
  return 'chrome' in window && !/iPhone|iPad|iPod/.test(navigator.userAgent);
}

let loading: Promise<boolean> | null = null;

/** Loads Google's Cast code, once. False when it won't load or says casting isn't available. */
function loadSender(): Promise<boolean> {
  loading ??= new Promise<boolean>((resolve) => {
    const done = (available: boolean) => { clearTimeout(timer); resolve(available); };
    const timer = setTimeout(() => done(false), 10_000);
    (window as unknown as { __onGCastApiAvailable: (available: boolean) => void }).__onGCastApiAvailable = done;
    const script = document.createElement('script');
    script.src = SENDER;
    script.onerror = () => done(false);
    document.head.append(script);
  });
  return loading;
}

const CONTENT_TYPES: Record<string, string> = { flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav' };

/** What the cast device shows about the song, and anything more for a receiver of Taiko's own. */
export interface CastSong {
  title: string;
  artist: string;
  album: string;
  art: string;
  /** The audio file's name, for its kind. */
  fileName: string;
  custom?: unknown;
}

type Handler = (event: Event) => void;

export class CastPlayer {
  paused = true;
  preload = '';
  crossOrigin: string | null = null;
  volume = 1;
  muted = false;
  readyState = 0;

  /** The cast device's name while a session is on, else ''. */
  device = '';
  /** Called when the session ends from the device's side, or another sender's. */
  onEnded: () => void = () => {};

  private url = '';
  private song: CastSong | null = null;
  private wantPlay = false;
  private startAt = 0;
  private loaded = false;
  private run = 0;
  private remote: RemotePlayer | null = null;
  private controller: RemoteController | null = null;
  private wired = false;
  /** The device's last word on where the song is, and when it said it, to carry the time on between words. */
  private told = 0;
  private toldAt = 0;
  private length = NaN;
  private ticker = 0;
  private readonly handlers = new Map<string, Set<{ handler: Handler; once: boolean }>>();

  /* ---------- The session ---------- */

  /**
   * Asks the listener which speaker or TV to cast to. Resolves to its name, or to '' when they chose none or
   * casting isn't available. Must be called from a click.
   */
  async connect(appId: string): Promise<string> {
    if (!(await loadSender())) return '';
    const { cast, chrome } = globals();
    const context = cast.framework.CastContext.getInstance();
    if (!this.wired) {
      this.wired = true;
      context.setOptions({ receiverApplicationId: appId || chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED });
      context.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
        if (event.sessionState === cast.framework.SessionState.SESSION_ENDED && this.device) {
          this.device = '';
          this.forget();
          this.onEnded();
        }
      });
      this.remote = new cast.framework.RemotePlayer();
      this.controller = new cast.framework.RemotePlayerController(this.remote);
      this.controller.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, (event) => this.heard(event.field, event.value));
    }
    try {
      await context.requestSession();
    } catch {
      return '';
    }
    this.device = context.getCurrentSession()?.getCastDevice().friendlyName ?? 'the cast device';
    return this.device;
  }

  /** Stops casting: the device stops playing and is let go. */
  disconnect(): void {
    const session = this.device ? globals().cast.framework.CastContext.getInstance().getCurrentSession() : null;
    this.device = '';
    this.forget();
    session?.endSession(true);
  }

  /* ---------- What an audio element has ---------- */

  /** Says what the song is, before its address is set. */
  describe(song: CastSong): void {
    this.song = song;
  }

  get src(): string { return this.url; }
  set src(url: string) {
    this.forget();
    this.url = url;
    if (!url) return;
    // The song is sent to the device once the store has said whether it is to play at once, and from where.
    const run = this.run;
    queueMicrotask(() => { if (run === this.run) void this.send(run); });
  }

  get currentTime(): number {
    if (!this.loaded) return this.startAt;
    const moved = this.paused ? 0 : (performance.now() - this.toldAt) / 1000;
    const at = this.told + moved;
    return Number.isFinite(this.length) ? Math.min(at, this.length) : at;
  }
  set currentTime(seconds: number) {
    if (!this.loaded || !this.remote || !this.controller) {
      this.startAt = seconds;
      return;
    }
    this.remote.currentTime = seconds;
    this.controller.seek();
    this.told = seconds;
    this.toldAt = performance.now();
    this.emit('seeked');
  }

  get duration(): number { return this.length; }

  getAttribute(name: string): string | null { return name === 'src' && this.url ? this.url : null; }
  setAttribute(): void { /* nothing an element's attributes do applies */ }
  removeAttribute(name: string): void { if (name === 'src') this.src = ''; }
  load(): void { /* a song is sent to the device when its address is set */ }

  addEventListener(type: string, handler: Handler, options?: { once?: boolean }): void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add({ handler, once: options?.once === true });
  }

  removeEventListener(type: string, handler: Handler): void {
    for (const entry of this.handlers.get(type) ?? []) if (entry.handler === handler) this.handlers.get(type)!.delete(entry);
  }

  private emit(type: string): void {
    for (const entry of [...(this.handlers.get(type) ?? [])]) {
      if (entry.once) this.handlers.get(type)!.delete(entry);
      entry.handler(new Event(type));
    }
  }

  async play(): Promise<void> {
    this.wantPlay = true;
    if (!this.loaded) return;
    if (this.remote?.isPaused) this.controller?.playOrPause();
  }

  pause(): void {
    this.wantPlay = false;
    if (this.loaded && this.remote && !this.remote.isPaused) this.controller?.playOrPause();
  }

  /* ---------- Between this page and the device ---------- */

  private forget(): void {
    this.run++;
    clearInterval(this.ticker);
    const was = !this.paused;
    this.url = '';
    this.loaded = false;
    this.wantPlay = false;
    this.startAt = 0;
    this.told = 0;
    this.length = NaN;
    this.readyState = 0;
    this.paused = true;
    if (was) this.emit('pause');
  }

  private async send(run: number): Promise<void> {
    const session = this.device ? globals().cast.framework.CastContext.getInstance().getCurrentSession() : null;
    const song = this.song;
    if (!session || !song) {
      this.emit('error');
      return;
    }
    const { chrome } = globals();
    const kind = CONTENT_TYPES[song.fileName.split('.').pop()?.toLowerCase() ?? ''] ?? 'audio/flac';
    const media = new chrome.cast.media.MediaInfo(this.url, kind);
    const about = new chrome.cast.media.MusicTrackMediaMetadata();
    about.title = song.title;
    about.artist = song.artist;
    about.albumName = song.album;
    if (song.art) about.images = [new chrome.cast.Image(song.art)];
    media.metadata = about;
    if (song.custom !== undefined) media.customData = song.custom;
    const request = new chrome.cast.media.LoadRequest(media);
    const from = this.startAt;
    request.currentTime = from;
    request.autoplay = this.wantPlay;
    try {
      await session.loadMedia(request);
    } catch {
      if (run === this.run) this.emit('error');
      return;
    }
    if (run !== this.run) return;
    this.loaded = true;
    this.readyState = 4;
    this.told = this.startAt;
    this.toldAt = performance.now();
    // The device says when the song has played to its end.
    const playing = session.getMediaSession();
    playing?.addUpdateListener((alive) => {
      if (run === this.run && !alive && playing.idleReason === globals().chrome.cast.media.IdleReason.FINISHED) {
        this.paused = true;
        clearInterval(this.ticker);
        this.emit('ended');
      }
    });
    this.emit('loadedmetadata');
    this.emit('canplay');
    // Whether it is playing is taken from the device as it stands; it only speaks again when that changes.
    if (this.remote && !this.remote.isPaused && this.paused) {
      this.paused = false;
      this.emit('play');
      this.emit('playing');
    }
    // The listener may have moved within the song, or asked for it to play, after it was sent.
    if (this.startAt !== from) this.currentTime = this.startAt;
    // Play may have been asked for after the song was sent.
    if (this.wantPlay && this.remote?.isPaused) this.controller?.playOrPause();
    clearInterval(this.ticker);
    this.ticker = window.setInterval(() => { if (!this.paused) this.emit('timeupdate'); }, 250);
  }

  /** The device (through Google's player) says something changed. */
  private heard(field: string, value: unknown): void {
    if (!this.loaded) return;
    if (field === 'currentTime' && typeof value === 'number') {
      this.told = value;
      this.toldAt = performance.now();
    } else if (field === 'duration' && typeof value === 'number' && value > 0) {
      this.length = value;
      this.emit('durationchange');
    } else if (field === 'isPaused') {
      const paused = value === true;
      if (paused === this.paused) return;
      // The time stops, or starts, from where it had got to.
      this.told = this.currentTime;
      this.toldAt = performance.now();
      this.paused = paused;
      this.emit(paused ? 'pause' : 'play');
      if (!paused) this.emit('playing');
    }
  }
}
