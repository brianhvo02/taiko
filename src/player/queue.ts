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

/* ---------- Changing what is to come ----------
 * Once the listener arranges the queue by hand, the list itself is put in the order it will play (`inPlayOrder`)
 * and the order beside it becomes 0, 1, 2…; these work on that list. A song is in a queue once, so adding one that
 * is already waiting moves it. The song that is playing is never moved or removed.
 */

/** The queue's songs in the sequence they will play. */
export function inPlayOrder<T>(queue: T[], order: number[]): T[] {
  return order.length === queue.length ? order.map((index) => queue[index]) : [...queue];
}

/** The list with `adding` placed straight after the playing song (`next`) or at the end. */
export function withQueued<T extends { id: string }>(list: T[], currentId: string, adding: T[], next: boolean): T[] {
  const seen = new Set([currentId]);
  const fresh = adding.filter((song) => !seen.has(song.id) && seen.add(song.id));
  const rest = list.filter((song) => song.id === currentId || !seen.has(song.id));
  const at = rest.findIndex((song) => song.id === currentId);
  return next ? [...rest.slice(0, at + 1), ...fresh, ...rest.slice(at + 1)] : [...rest, ...fresh];
}

/** The list with a waiting song moved one place up or down, or to straight after the playing song. Never past it. */
export function withMovedInQueue<T extends { id: string }>(list: T[], currentId: string, id: string, to: 'up' | 'down' | 'next'): T[] {
  const first = list.findIndex((song) => song.id === currentId) + 1;
  const from = list.findIndex((song) => song.id === id);
  if (from < first) return list;
  const target = to === 'next' ? first : to === 'up' ? from - 1 : from + 1;
  if (target < first || target >= list.length || target === from) return list;
  const moved = [...list];
  moved.splice(target, 0, ...moved.splice(from, 1));
  return moved;
}

/** The list without a waiting song. */
export function withoutQueued<T extends { id: string }>(list: T[], currentId: string, id: string): T[] {
  return id === currentId ? list : list.filter((song) => song.id !== id);
}

/** The list up to and including the playing song: nothing left to come. */
export function withoutUpcoming<T extends { id: string }>(list: T[], currentId: string): T[] {
  const at = list.findIndex((song) => song.id === currentId);
  return at < 0 ? list : list.slice(0, at + 1);
}
