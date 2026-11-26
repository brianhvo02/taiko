/**
 * The engine: plays a FLAC stream by decoding it in short pieces and scheduling them back to back, to the sample.
 *
 * An audio element can't be told exactly when to start, so two songs played on two elements always join with a
 * gap or an overlap. Web Audio can: a decoded buffer starts on the sample frame it is told to. So the engine
 * fetches the stream, cuts it into pieces of whole frames (shared/flacstream.ts), has the browser decode each, and
 * schedules them one after another; and a second player can be told to begin on the very frame the first one
 * ends on. That is gapless playback. The owner's iPhone joined two songs this way without a seam (trial test 7).
 *
 * Two things make it exact. The audio context runs at the file's own sample rate, so nothing is resampled and a
 * decoded piece has exactly the samples its frames hold; there is one context ("bus") per sample rate. And times
 * are counted in whole frames from a base, never added up as seconds.
 *
 * A bus's sound leaves through an ordinary audio element fed by a MediaStream, as the mixer's does (mixer.ts):
 * Safari stops Web Audio on a locked phone otherwise.
 *
 * An `EnginePlayer` looks enough like an audio element for the player's store to drive it the same way: `src`,
 * `play()`, `pause()`, `currentTime`, and the events `play`, `pause`, `playing`, `canplay`, `timeupdate`, `ended`
 * and `error`. It never seeks: the store already plays a new stream that begins at the frame (flac.ts), and the
 * engine plays streams from their start.
 */
import { FlacStreamParser } from '../shared/flacstream';

/** How much audio is scheduled ahead of what is sounding, in seconds. A locked phone slows a page's timers to about one a second. */
const AHEAD_SECONDS = 30;
/** How long before the first piece sounds, in seconds: room for the scheduling itself. */
const START_LEAD = 0.06;

interface Bus {
  rate: number;
  context: AudioContext;
  out: MediaStreamAudioDestinationNode;
  speaker: HTMLAudioElement;
  players: Set<EnginePlayer>;
}

type ContextClass = typeof AudioContext;
const contextClass = (): ContextClass | undefined => window.AudioContext ?? (window as unknown as { webkitAudioContext?: ContextClass }).webkitAudioContext;

/** Whether this browser has what the engine needs. */
export function enginePossible(): boolean {
  const Context = contextClass();
  return typeof Context === 'function' && typeof Context.prototype.createMediaStreamDestination === 'function' && typeof Context.prototype.decodeAudioData === 'function';
}

/**
 * Moves a volume along a curve over `seconds`, as a run of short straight ramps. (A browser's own curve can't
 * always be cut short once it has begun; ramps can, and at this many steps the ear can't tell.)
 */
export function rampAlong(param: AudioParam, curve: Float32Array, from: number, seconds: number): void {
  param.setValueAtTime(curve[0], from);
  for (let step = 1; step < curve.length; step++) param.linearRampToValueAtTime(curve[step], from + (seconds * step) / (curve.length - 1));
}

/** The buses, one per sample rate, shared by the engine's players. */
export class Engine {
  private readonly buses = new Map<number, Bus>();

  /** The bus for a sample rate, made if need be. Throws where the browser won't run a context at that rate. */
  bus(rate: number): Bus {
    let bus = this.buses.get(rate);
    if (bus) return bus;
    const Context = contextClass()!;
    const context = new Context({ sampleRate: rate });
    if (context.sampleRate !== rate) {
      void context.close();
      throw new Error('rate');
    }
    const out = context.createMediaStreamDestination();
    const speaker = new Audio();
    speaker.srcObject = out.stream;
    bus = { rate, context, out, speaker, players: new Set() };
    const made = bus;
    // The phone pausing the speaker (a call, another app's sound) pauses the songs on it.
    speaker.addEventListener('pause', () => { for (const player of made.players) if (!player.paused && !made.resting) player.pause(); });
    this.buses.set(rate, bus);
    return bus;
  }

  /** Makes the bus for a rate ready inside a tap, where a phone allows sound to be started. */
  prime(rate: number): void {
    try {
      const bus = this.bus(rate);
      if (bus.context.state !== 'running') void bus.context.resume().catch(() => {});
    } catch {
      // The song will say so when it is played.
    }
  }

  /** Gets the speakers of buses that have something to play going. */
  wake(): void {
    for (const bus of this.buses.values()) {
      if (![...bus.players].some((player) => !player.paused)) continue;
      (bus as Bus & { resting?: boolean }).resting = false;
      if (bus.speaker.paused) void bus.speaker.play().catch(() => {});
    }
  }

  /** Stops the speakers of buses where nothing is playing, so the phone knows. */
  rest(): void {
    for (const bus of this.buses.values()) {
      if ([...bus.players].some((player) => !player.paused)) continue;
      (bus as Bus & { resting?: boolean }).resting = true;
      bus.speaker.pause();
    }
  }
}

interface Bus {
  /** True while the engine itself has paused the speaker, so that pause isn't taken for the phone's. */
  resting?: boolean;
}

type Handler = (event: Event) => void;

export class EnginePlayer {
  paused = true;
  preload = '';
  crossOrigin: string | null = null;
  /** Kept for the store's sake; the engine's loudness is `setGain`. */
  volume = 1;
  readyState = 0;
  /** Why the last `error` happened: 'suspended' when the browser wouldn't start sound, else what went wrong. */
  failure = '';

  private url = '';
  private run = 0;
  private abort: AbortController | null = null;
  private bus: Bus | null = null;
  private fadeNode: GainNode | null = null;
  private levelNode: GainNode | null = null;
  private gain = 1;
  private fade = 1;
  private isMuted = false;
  private nodes: AudioBufferSourceNode[] = [];
  /** The context frame the stream's first sample sounds on; -1 until the first piece is scheduled. */
  private base = -1;
  private scheduled = 0;
  private total = 0;
  private finishedLoading = false;
  private ended = false;
  private after: EnginePlayer | null = null;
  private ticker = 0;
  private readonly handlers = new Map<string, Set<{ handler: Handler; once: boolean }>>();

  constructor(private readonly engine: Engine) {}

  /* ---------- What an audio element has ---------- */

  get src(): string { return this.url; }
  set src(url: string) {
    this.reset();
    this.url = url;
  }

  get muted(): boolean { return this.isMuted; }
  set muted(muted: boolean) {
    this.isMuted = muted;
    this.applyGain();
  }

  /** Seconds into the stream. Setting it does nothing: the store seeks by playing a new stream. */
  get currentTime(): number {
    if (!this.bus || this.base < 0) return 0;
    const frames = Math.round(this.bus.context.currentTime * this.bus.rate) - this.base;
    return Math.max(0, Math.min(frames, this.scheduled)) / this.bus.rate;
  }
  set currentTime(_seconds: number) { /* never sought */ }

  get duration(): number {
    return this.bus && this.total ? this.total / this.bus.rate : NaN;
  }

  getAttribute(name: string): string | null { return name === 'src' && this.url ? this.url : null; }
  setAttribute(): void { /* nothing an element's attributes do applies */ }
  removeAttribute(name: string): void { if (name === 'src') this.src = ''; }
  load(): void { /* a stream is loaded when it is played */ }

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
    if (!this.url) throw new Error('no source');
    const wasPaused = this.paused;
    this.paused = false;
    if (wasPaused) this.emit('play');
    if (this.bus) {
      this.engine.wake();
      if (this.bus.context.state !== 'running') await this.bus.context.resume().catch(() => {});
    }
    if (this.base >= 0) {
      if (wasPaused) this.emit('playing');
    } else if (!this.abort) {
      void this.loadAndSchedule();
    }
    this.tick();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    clearInterval(this.ticker);
    // The context stops, and everything scheduled on it with it: this song, and one waiting to follow it.
    if (this.bus && ![...this.bus.players].some((player) => player !== this && !player.paused && player.after !== this)) void this.bus.context.suspend().catch(() => {});
    this.emit('pause');
  }

  /* ---------- What only the engine has ---------- */

  /** How loud the song comes out, before its fade: the listener's volume times the song's level. */
  setGain(gain: number): void {
    this.gain = gain;
    this.applyGain();
  }

  private applyGain(): void {
    if (!this.levelNode || !this.bus) return;
    const now = this.bus.context.currentTime;
    this.levelNode.gain.cancelScheduledValues(now);
    this.levelNode.gain.setTargetAtTime(this.isMuted ? 0 : this.gain, now, 0.015);
  }

  /** Sets the fade at once (0 silent, 1 full), or over `seconds` along `curve` when one is given. */
  setFade(value: number, seconds = 0, curve?: Float32Array<ArrayBuffer>): void {
    this.fade = value;
    if (!this.fadeNode || !this.bus) return;
    const now = this.bus.context.currentTime;
    // Everything set for it goes, a fade under way included: some browsers refuse a new value in the middle of one
    // unless it is cancelled from its start.
    this.fadeNode.gain.cancelScheduledValues(0);
    if (seconds > 0.05 && curve) rampAlong(this.fadeNode.gain, curve, now, seconds);
    else this.fadeNode.gain.setValueAtTime(value, now);
  }

  /**
   * Tells this player to begin on the very frame `other` ends on, and starts loading. If the two streams aren't at
   * the same sample rate, or the other's end isn't known in time, it simply starts when played.
   */
  follow(other: EnginePlayer): void {
    this.after = other;
    this.paused = false;
    if (!this.abort && this.url) void this.loadAndSchedule();
  }

  /** Whether the stream has played to its end (or was never started). */
  get over(): boolean { return this.ended; }

  /** Whether this player is set to begin exactly where another ends, and its first piece is already in place. */
  get joined(): boolean { return this.after !== null && this.base >= 0 && this.exactJoin; }
  private exactJoin = false;

  /** The context frame this stream ends on, once that is certain: every piece scheduled, or the length known. */
  private endFrame(): number {
    if (this.base < 0) return -1;
    if (this.finishedLoading) return this.base + this.scheduled;
    return this.total ? this.base + this.total : -1;
  }

  /** For tests: where this stream begins and ends on its bus, in frames, and the bus's rate. */
  get timeline(): { rate: number; base: number; end: number; scheduled: number } | null {
    return this.bus ? { rate: this.bus.rate, base: this.base, end: this.endFrame(), scheduled: this.scheduled } : null;
  }

  private tick(): void {
    clearInterval(this.ticker);
    this.ticker = window.setInterval(() => { if (!this.paused && this.base >= 0) this.emit('timeupdate'); }, 250);
  }

  private reset(): void {
    this.run++;
    this.abort?.abort();
    this.abort = null;
    clearInterval(this.ticker);
    for (const node of this.nodes) {
      node.onended = null;
      try { node.stop(); } catch { /* not started */ }
      node.disconnect();
    }
    this.nodes = [];
    this.fadeNode?.disconnect();
    this.levelNode?.disconnect();
    this.fadeNode = null;
    this.levelNode = null;
    this.bus?.players.delete(this);
    this.bus = null;
    this.base = -1;
    this.scheduled = 0;
    this.total = 0;
    this.finishedLoading = false;
    this.ended = false;
    this.after = null;
    this.exactJoin = false;
    this.paused = true;
    this.readyState = 0;
    this.failure = '';
    this.url = '';
  }

  private fail(run: number, why: string): void {
    if (run !== this.run) return;
    this.failure = why;
    this.abort?.abort();
    this.abort = null;
    this.paused = true;
    clearInterval(this.ticker);
    this.emit('error');
  }

  /** Fetches the stream, and decodes and schedules it piece by piece, keeping a little ahead of what is sounding. */
  private async loadAndSchedule(): Promise<void> {
    const run = this.run;
    const abort = new AbortController();
    this.abort = abort;
    const parser = new FlacStreamParser(2);
    try {
      const response = await fetch(this.url, { signal: abort.signal });
      if (!response.ok || !response.body) throw new Error('fetch');
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (run !== this.run) return;
        const pieces = done ? parser.end() : parser.push(value);
        for (const piece of pieces) {
          if (!this.bus) this.attach(parser.info!.sampleRate, parser.info!.totalSamples);
          const bus = this.bus!;
          const buffer = await bus.context.decodeAudioData(piece.bytes.buffer);
          if (run !== this.run) return;
          if (this.base < 0) await this.begin(run);
          if (run !== this.run) return;
          this.schedule(buffer);
          // Enough is in hand: wait, without filling the phone's memory with a whole album.
          while (run === this.run && (this.scheduled - this.playedFrames()) / bus.rate > AHEAD_SECONDS) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          if (run !== this.run) return;
        }
        if (done) break;
      }
      if (this.base < 0) throw new Error('empty');
      this.finishedLoading = true;
      // A stream so short that it had finished sounding before its end was known.
      if (this.nodes.length === 0 && !this.ended) {
        this.ended = true;
        this.paused = true;
        clearInterval(this.ticker);
        this.emit('ended');
      }
    } catch (error) {
      if (run !== this.run || abort.signal.aborted) return;
      this.fail(run, error instanceof Error ? error.message : 'failed');
    }
  }

  private playedFrames(): number {
    if (!this.bus || this.base < 0) return 0;
    return Math.max(0, Math.round(this.bus.context.currentTime * this.bus.rate) - this.base);
  }

  /** Joins the bus for the stream's sample rate and sets up this player's volume controls on it. */
  private attach(rate: number, total: number): void {
    const bus = this.engine.bus(rate);
    this.bus = bus;
    this.total = total;
    bus.players.add(this);
    this.fadeNode = bus.context.createGain();
    this.levelNode = bus.context.createGain();
    this.fadeNode.gain.value = this.fade;
    this.levelNode.gain.value = this.isMuted ? 0 : this.gain;
    this.fadeNode.connect(this.levelNode).connect(bus.out);
  }

  /** Decides the frame the stream begins on: where the song before ends, when that can be exact, else just ahead. */
  private async begin(run: number): Promise<void> {
    const bus = this.bus!;
    const before = this.after;
    const soon = (): number => Math.ceil((bus.context.currentTime + START_LEAD) * bus.rate);
    if (before && before.bus === bus && before.endFrame() >= soon()) {
      this.base = before.endFrame();
      this.exactJoin = true;
    } else {
      // It can't be joined to the song before (another sample rate, or its end isn't known): wait for that song to
      // end, then start as any song does. It is already decoded, so the wait after is short.
      while (before && run === this.run && !before.over && before.url) await new Promise((resolve) => setTimeout(resolve, 40));
      if (run !== this.run) return;
      // Sound has to be allowed to start: a browser may hold a context that wasn't started in a tap. It is asked,
      // the song is scheduled regardless (some browsers only start a context once something is set to play on it),
      // and if nothing has moved a moment later the player is told, and plays the song the ordinary way.
      this.engine.wake();
      if (bus.context.state !== 'running') void bus.context.resume().catch(() => {});
      this.base = soon();
      window.setTimeout(() => {
        if (run === this.run && !this.paused && bus.context.state !== 'running') this.fail(run, 'suspended');
      }, 1500);
    }
    this.readyState = 4;
    this.engine.wake();
    this.emit('canplay');
    if (!this.paused) this.emit('playing');
  }

  private schedule(buffer: AudioBuffer): void {
    const bus = this.bus!;
    // A stream that fell behind (a stalled network) carries on from now; what is sounding never overlaps.
    const now = Math.ceil((bus.context.currentTime + 0.02) * bus.rate);
    if (this.base + this.scheduled < now && !this.exactJoin) this.base = now - this.scheduled;
    const node = bus.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.fadeNode!);
    node.start((this.base + this.scheduled) / bus.rate);
    this.scheduled += buffer.length;
    this.nodes.push(node);
    node.onended = () => {
      this.nodes = this.nodes.filter((other) => other !== node);
      node.disconnect();
      if (this.finishedLoading && this.nodes.length === 0 && !this.ended) {
        this.ended = true;
        this.paused = true;
        clearInterval(this.ticker);
        this.emit('ended');
      }
    };
  }
}
