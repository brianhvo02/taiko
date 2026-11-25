import { describe, expect, it } from 'vitest';
import { inPlayOrder, withMovedInQueue, withQueued, withoutQueued, withoutUpcoming } from './queue';

describe('changing what is to come', () => {
  const songs = (...ids: string[]) => ids.map((id) => ({ id }));
  const ids = (list: { id: string }[]) => list.map((song) => song.id).join('');

  it('puts the list in the order it will play', () => {
    expect(ids(inPlayOrder(songs('a', 'b', 'c'), [2, 0, 1]))).toBe('cab');
    expect(ids(inPlayOrder(songs('a', 'b'), []))).toBe('ab');
  });

  it('adds songs next or last, moving one that is already waiting and leaving the playing one', () => {
    const list = songs('a', 'b', 'c', 'd');
    expect(ids(withQueued(list, 'b', songs('x', 'y'), true))).toBe('abxycd');
    expect(ids(withQueued(list, 'b', songs('x', 'y'), false))).toBe('abcdxy');
    // Already waiting, or already played: moved, not listed twice. The playing song stays put.
    expect(ids(withQueued(list, 'b', songs('d', 'a', 'b', 'd'), true))).toBe('bdac');
    expect(ids(withQueued(list, 'b', songs('c'), false))).toBe('abdc');
  });

  it('moves a waiting song up, down or to the front, never past the playing song', () => {
    const list = songs('a', 'b', 'c', 'd', 'e');
    expect(ids(withMovedInQueue(list, 'b', 'd', 'up'))).toBe('abdce');
    expect(ids(withMovedInQueue(list, 'b', 'd', 'down'))).toBe('abced');
    expect(ids(withMovedInQueue(list, 'b', 'e', 'next'))).toBe('abecd');
    expect(withMovedInQueue(list, 'b', 'c', 'up')).toBe(list);
    expect(withMovedInQueue(list, 'b', 'e', 'down')).toBe(list);
    expect(withMovedInQueue(list, 'b', 'a', 'down')).toBe(list);
  });

  it('removes a waiting song, or all of them', () => {
    const list = songs('a', 'b', 'c', 'd');
    expect(ids(withoutQueued(list, 'b', 'c'))).toBe('abd');
    expect(withoutQueued(list, 'b', 'b')).toBe(list);
    expect(ids(withoutUpcoming(list, 'b'))).toBe('ab');
  });
});
