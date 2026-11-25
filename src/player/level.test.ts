import { describe, expect, it } from 'vitest';
import { levelFactor } from './level';

describe('levelFactor', () => {
  it('leaves a song without loudness tags as it is', () => {
    expect(levelFactor({}, false)).toBe(1);
    expect(levelFactor({ trackPeak: 0.9 }, true)).toBe(1);
  });

  it('turns a loud song down by its gain, less the pre-amp', () => {
    // -10 dB with +4 dB of pre-amp is -6 dB: about half.
    expect(levelFactor({ trackGain: -10, trackPeak: 1 }, false)).toBeCloseTo(0.501, 3);
  });

  it('uses the album\'s gain for an album played through, and the song\'s own otherwise', () => {
    const song = { trackGain: -4, albumGain: -10, trackPeak: 0.5, albumPeak: 1 };
    expect(levelFactor(song, true)).toBeCloseTo(0.501, 3);
    expect(levelFactor(song, false)).toBeCloseTo(1, 3);
    // Whichever is there, when one is missing.
    expect(levelFactor({ albumGain: -10 }, false)).toBeCloseTo(0.501, 3);
    expect(levelFactor({ trackGain: -10 }, true)).toBeCloseTo(0.501, 3);
  });

  it('never pushes the peak past full scale, nor past the ceiling', () => {
    // A quiet song would be turned up 6 dB (x2), but its peak allows only x1.25.
    expect(levelFactor({ trackGain: 2, trackPeak: 0.8 }, false)).toBeCloseTo(1.25, 3);
    // A true peak over 1 is believed: the song is held under it.
    expect(levelFactor({ trackGain: -4, trackPeak: 1.09 }, false)).toBeCloseTo(1 / 1.09, 3);
    expect(levelFactor({ trackGain: 2, trackPeak: 0.5 }, false, 1)).toBe(1);
  });
});
