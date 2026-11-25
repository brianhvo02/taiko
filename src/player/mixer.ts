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
export class Mixer {
  readonly context: AudioContext;
  readonly gain: GainNode;
  readonly speaker: HTMLAudioElement;
  private level = 1;
  private ducked = false;

  constructor(source: HTMLAudioElement) {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.context = new Context();
    this.gain = this.context.createGain();
    const out = this.context.createMediaStreamDestination();
    source.crossOrigin = 'anonymous';
    this.context.createMediaElementSource(source).connect(this.gain).connect(out);
    this.speaker = new Audio();
    this.speaker.srcObject = out.stream;
  }

  /** Gets the sound flowing: called when a song is asked to play, from a tap or from the lock screen. */
  wake(): void {
    if (this.context.state !== 'running') void this.context.resume().catch(() => {});
    if (this.speaker.paused) void this.speaker.play().catch(() => {});
  }

  /** Stops the speaker when the listener has paused, so the phone knows nothing is playing. */
  rest(): void {
    this.speaker.pause();
  }

  /** Sets how loud the song comes out: 1 is as it is. A short glide, so a change mid-song doesn't click. */
  setLevel(level: number): void {
    this.level = level;
    if (!this.ducked) this.gain.gain.setTargetAtTime(level, this.context.currentTime, 0.015);
  }

  /** Silences the song at once while it jumps to another moment, so the old one can't go on sounding. */
  duck(): void {
    this.ducked = true;
    this.gain.gain.cancelScheduledValues(this.context.currentTime);
    this.gain.gain.setValueAtTime(0, this.context.currentTime);
  }

  /** Brings the song back after a jump. */
  unduck(): void {
    if (!this.ducked) return;
    this.ducked = false;
    this.gain.gain.setTargetAtTime(this.level, this.context.currentTime, 0.015);
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
