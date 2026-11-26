/**
 * The mixer: the song's sound taken out of its audio element, through a volume control, and played by a second,
 * ordinary audio element ("the speaker").
 *
 * It exists for phones. A page can't set an audio element's volume on an iPhone, so the only way to turn a song
 * down there (volume levelling now; crossfade and exact joins later) is Web Audio. But Safari stops Web Audio when
 * the phone locks, unless its sound leaves through a media element, which a locked phone leaves alone. The
 * owner's iPhone confirmed both halves in a trial (public/trial.html, tests 3, 4, 6, 7 and 9), and that the lock
 * screen's controls and progress bar go on working. What doesn't work through this route is AirPlay: the speaker
 * plays a live stream, which can't be handed to another device.
 *
 * An element taken into the mixer stays in it: its sound no longer comes out by itself. And the element must be
 * told to ask for its audio in a way that lets a page read it (`crossOrigin`) before the audio is loaded, or the
 * mixer hears silence; the NAS allows that for the player's address.
 */
/**
 * The two players a song can sound from ("decks"), and how loud each comes out.
 *
 * One deck plays the song; the other is idle until a crossfade, when the next song starts on it while the first
 * fades away, and the two swap roles. Each deck's loudness is three things multiplied: the listener's volume, the
 * song's level (volume levelling, level.ts) and its fade (1, except during a crossfade).
 *
 * Without the mixer that product is the element's own volume, which can only turn a song down, and fades are
 * stepped by a timer. With it, each element's sound runs through a fade gain and a level gain into the speaker, the
 * listener's volume is the device's own, and fades are ramps the audio system runs by itself, so they stay smooth
 * on a locked phone where a page's timers are slowed.
 */
export class Decks {
  readonly elements: [HTMLAudioElement, HTMLAudioElement] = [new Audio(), new Audio()];
  /** The mixer's parts, once it is on. */
  mixer: { context: AudioContext; fades: [GainNode, GainNode]; levels: [GainNode, GainNode]; speaker: HTMLAudioElement } | null = null;
  private volume = 1;
  private readonly level = [1, 1];
  private readonly fade = [1, 1];
  private readonly ducked = [false, false];
  private readonly timers = [0, 0];

  /** Takes both elements into the mixer. Throws where the browser can't. Done once. */
  startMixer(): void {
    if (this.mixer) return;
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new Context();
    const out = context.createMediaStreamDestination();
    const chain = (element: HTMLAudioElement): [GainNode, GainNode] => {
      element.crossOrigin = 'anonymous';
      // Their own volume is out of it now; the gains decide.
      element.volume = 1;
      const fade = context.createGain();
      const level = context.createGain();
      context.createMediaElementSource(element).connect(fade).connect(level).connect(out);
      return [fade, level];
    };
    const [fadeA, levelA] = chain(this.elements[0]);
    const [fadeB, levelB] = chain(this.elements[1]);
    const speaker = new Audio();
    speaker.srcObject = out.stream;
    this.mixer = { context, fades: [fadeA, fadeB], levels: [levelA, levelB], speaker };
    for (const deck of [0, 1]) this.apply(deck);
  }

  /** Gets the sound flowing: called when a song is asked to play, from a tap or from the lock screen. */
  wake(): void {
    if (!this.mixer) return;
    if (this.mixer.context.state !== 'running') void this.mixer.context.resume().catch(() => {});
    if (this.mixer.speaker.paused) void this.mixer.speaker.play().catch(() => {});
  }

  /** Stops the speaker when the listener has paused, so the phone knows nothing is playing. */
  rest(): void {
    this.mixer?.speaker.pause();
  }

  private apply(deck: number): void {
    if (this.mixer) {
      const { context, levels } = this.mixer;
      levels[deck].gain.cancelScheduledValues(context.currentTime);
      if (this.ducked[deck]) levels[deck].gain.setValueAtTime(0, context.currentTime);
      else levels[deck].gain.setTargetAtTime(this.level[deck], context.currentTime, 0.015);
    } else {
      this.elements[deck].volume = Math.max(0, Math.min(1, this.volume * Math.min(1, this.level[deck]) * this.fade[deck] * (this.ducked[deck] ? 0 : 1)));
    }
  }

  /** The listener's volume, for both decks. (Through the mixer the device's own buttons set it.) */
  setVolume(volume: number): void {
    this.volume = volume;
    for (const deck of [0, 1]) this.apply(deck);
  }

  /** How loud a deck's song is to come out next to others: 1 is as it is. */
  setLevel(deck: number, level: number): void {
    this.level[deck] = level;
    this.apply(deck);
  }

  /** Silences a deck at once while its song jumps to another moment, and brings it back after. */
  duck(deck: number, on: boolean): void {
    if (this.ducked[deck] === on) return;
    this.ducked[deck] = on;
    this.apply(deck);
  }

  /** Sets a deck's fade at once: 0 is silent, 1 is full. Any fade under way on it stops. */
  setFade(deck: number, value: number): void {
    clearInterval(this.timers[deck]);
    this.fade[deck] = value;
    if (this.mixer) {
      const { context, fades } = this.mixer;
      fades[deck].gain.cancelScheduledValues(context.currentTime);
      fades[deck].gain.setValueAtTime(value, context.currentTime);
    } else {
      this.apply(deck);
    }
  }

  /**
   * Fades a deck to `to` over `seconds`, from where it is. The curve keeps two songs crossing at about the same
   * loudness together (each at 71% half-way), not dipping in the middle as a straight line would.
   */
  rampFade(deck: number, to: number, seconds: number): void {
    const from = this.fade[deck];
    if (seconds <= 0.05 || from === to) {
      this.setFade(deck, to);
      return;
    }
    const shape = (progress: number): number => {
      const eased = to > from ? Math.sin((progress * Math.PI) / 2) : Math.cos((progress * Math.PI) / 2);
      return to > from ? from + (to - from) * eased : to + (from - to) * eased;
    };
    clearInterval(this.timers[deck]);
    this.fade[deck] = to;
    if (this.mixer) {
      const { context, fades } = this.mixer;
      const curve = Float32Array.from({ length: 64 }, (_, step) => shape(step / 63));
      fades[deck].gain.cancelScheduledValues(context.currentTime);
      try {
        fades[deck].gain.setValueCurveAtTime(curve, context.currentTime, seconds);
      } catch {
        fades[deck].gain.setValueAtTime(from, context.currentTime);
        fades[deck].gain.linearRampToValueAtTime(to, context.currentTime + seconds);
      }
      return;
    }
    const began = performance.now();
    const step = (): void => {
      const progress = Math.min(1, (performance.now() - began) / (seconds * 1000));
      this.fade[deck] = shape(progress);
      this.apply(deck);
      if (progress >= 1) clearInterval(this.timers[deck]);
    };
    this.timers[deck] = window.setInterval(step, 40);
    step();
  }
}


/** Whether this browser has what the mixer needs. */
export function mixerPossible(): boolean {
  const context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
  return typeof context === 'function' && typeof (context as typeof AudioContext).prototype.createMediaStreamDestination === 'function';
}

const KEY = 'taiko:mixer';

/** Whether the listener has turned the mixer on in this browser. It stays off until they do. */
export function mixerWanted(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export function keepMixerWanted(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, 'on');
    else localStorage.removeItem(KEY);
  } catch {
    // Without storage the choice lasts until the tab closes.
  }
}
