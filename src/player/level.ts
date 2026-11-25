/**
 * Volume levelling: how much to turn a song down (or up) so that songs from different albums sound about as loud
 * as each other. The numbers come from the ReplayGain tags in the file (`trackGain`, `albumGain` in decibels to
 * reach -18 LUFS, and the peaks); a song without them is played as it is.
 */

/** Added to every gain, in decibels: ReplayGain's level is quieter than most players'; this lands near -14 LUFS. */
export const PRE_AMP_DB = 4;

export interface Loudness {
  trackGain?: number;
  trackPeak?: number;
  albumGain?: number;
  albumPeak?: number;
}

/**
 * The factor to multiply the volume by. With `album`, the album's gain is used, so an album played through keeps
 * its own quiet and loud songs; otherwise the song's own. The factor is kept under what would push the peak past
 * full scale, and under `ceiling`: a player that can only turn down passes 1.
 */
export function levelFactor(song: Loudness, album: boolean, ceiling = Infinity): number {
  const gain = (album ? song.albumGain ?? song.trackGain : song.trackGain ?? song.albumGain);
  if (gain === undefined) return 1;
  const peak = (album ? song.albumPeak ?? song.trackPeak : song.trackPeak ?? song.albumPeak) ?? 0;
  const factor = 10 ** ((gain + PRE_AMP_DB) / 20);
  return Math.min(factor, peak > 0 ? 1 / peak : Infinity, ceiling);
}
