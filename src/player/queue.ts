/**
 * The order songs play in. A queue is a list of songs; the order is the sequence of its positions to play: 0, 1,
 * 2… as listed, or shuffled. Keeping the order beside the list (not shuffling the list) means the Songs panel
 * still shows an album in album order, Back returns to the song that really played before, and turning shuffle
 * off carries on from the open song in the listed order.
 */

export type Repeat = 'off' | 'all' | 'one';

/** A random number in [0, 1), as Math.random gives; tests pass their own. */
export type Random = () => number;

/**
 * The order to play a queue of `length` songs in. Shuffled, the song at `current` comes first (it is playing, or
 * was just chosen) and the rest follow in random order; with no current song, all of it is random.
 */
export function makeOrder(length: number, shuffle: boolean, current = -1, random: Random = Math.random): number[] {
  const order = Array.from({ length }, (_, i) => i);
  if (!shuffle) return order;
  const first = current >= 0 && current < length ? 1 : 0;
  if (first) {
    order.splice(current, 1);
    order.unshift(current);
  }
  for (let i = order.length - 1; i > first; i--) {
    const j = first + Math.floor(random() * (i - first + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export interface Step {
  /** The queue position to play next, or -1 when there is nowhere to go. */
  index: number;
  /** Whether the step passed the end (or the start) and came round again. */
  wrapped: boolean;
}

/**
 * Where Next (1) or Previous (-1) leads from the queue position `at`. Past either end there is nowhere to go,
 * unless everything repeats, when it comes round. Repeating one song changes what happens when a song ends, not
 * what the buttons do, so it steps like 'off'.
 */
export function stepFrom(order: number[], at: number, direction: 1 | -1, repeat: Repeat): Step {
  const place = order.indexOf(at);
  if (place < 0 || !order.length) return { index: -1, wrapped: false };
  const next = place + direction;
  if (next >= 0 && next < order.length) return { index: order[next], wrapped: false };
  if (repeat !== 'all') return { index: -1, wrapped: false };
  return { index: order[next < 0 ? order.length - 1 : 0], wrapped: true };
}

/** The next setting when the repeat button is pressed: off, everything, one song, off. */
export const nextRepeat = (repeat: Repeat): Repeat => (repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off');
