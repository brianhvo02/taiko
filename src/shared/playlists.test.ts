import { describe, expect, it } from 'vitest';
import { NEVER_SYNCED, acceptPlaylists, noteChanges, reconcile, withoutLostTransitions } from './playlists';
import type { Playlist } from './playlists';

const song = (id: string) => ({ id, title: id, artist: '', album: '', trackNumber: null, discNumber: null, durationSeconds: null });
const list = (id: string, ...songs: string[]): Playlist => ({ id, name: id, tracks: songs.map(song) });

describe('reconcile', () => {
  it('adds what a device had before sharing began, the first time', () => {
    const merged = reconcile([list('a', 'x'), list('b')], [list('b', 'y'), list('c')], NEVER_SYNCED);
    expect(merged.playlists.map((p) => p.id)).toEqual(['b', 'c', 'a']);
    // The NAS's copy of a playlist both have is kept.
    expect(merged.playlists[0].tracks).toHaveLength(1);
    expect(merged.push).toBe(true);
    expect(reconcile([], [list('c')], NEVER_SYNCED)).toEqual({ playlists: [list('c')], push: false });
  });

  it('takes the NAS as it is when nothing changed here, dropping what another device deleted', () => {
    const merged = reconcile([list('a'), list('gone')], [list('a', 'x'), list('new')], { version: 3, dirty: [], deleted: [] });
    expect(merged).toEqual({ playlists: [list('a', 'x'), list('new')], push: false });
  });

  it('sends what was made, changed and deleted here', () => {
    const local = [list('a', 'mine'), list('made')];
    const merged = reconcile(local, [list('a', 'theirs'), list('b'), list('c')], { version: 3, dirty: ['a', 'made'], deleted: ['b'] });
    expect(merged.playlists).toEqual([list('a', 'mine'), list('c'), list('made')]);
    expect(merged.push).toBe(true);
    // Changed here but deleted elsewhere: the change brings it back.
    expect(reconcile([list('a', 'mine')], [], { version: 3, dirty: ['a'], deleted: [] }).playlists).toEqual([list('a', 'mine')]);
  });
});

describe('noteChanges', () => {
  it('marks playlists made, changed and deleted', () => {
    const a = list('a');
    const b = list('b');
    const sync = noteChanges([a, b], [{ ...a, name: 'renamed' }, list('c')], { version: 2, dirty: ['b'], deleted: [] });
    expect(sync).toEqual({ version: 2, dirty: ['a', 'c'], deleted: ['b'] });
    // The same list changes nothing; a deleted playlist made again is no longer deleted.
    expect(noteChanges([a], [a], { version: 2, dirty: [], deleted: [] })).toEqual({ version: 2, dirty: [], deleted: [] });
    expect(noteChanges([], [b], sync).deleted).toEqual([]);
  });
});

describe('transitions', () => {
  it('are kept with the playlist, inside what the player allows, and dropped when they are not transitions', () => {
    const kept = acceptPlaylists([{ ...list('a', 'x', 'y'), transitions: {
      'x>y': { kind: 'fade', seconds: 99, leave: 12.34, startAt: -3, extra: true },
      'y>x': { kind: 'cut', seconds: 8, leave: 500, startAt: 2 },
      'x>z': { kind: 'wipe', seconds: 4 },
      nonsense: 'yes',
    } }]);
    expect(kept![0].transitions).toEqual({
      'x>y': { kind: 'fade', seconds: 20, leave: 12.3, startAt: 0 },
      'y>x': { kind: 'cut', seconds: 0, leave: 120, startAt: 2 },
    });
    expect(acceptPlaylists([{ ...list('a'), transitions: { 'x>y': 1 } }])![0]).not.toHaveProperty('transitions');
  });

  it('go when one of their two songs leaves the playlist', () => {
    const fade = { kind: 'fade' as const, seconds: 4, leave: 0, startAt: 0 };
    const playlist = { ...list('a', 'x', 'y'), transitions: { 'x>y': fade, 'y>z': fade } };
    expect(withoutLostTransitions(playlist).transitions).toEqual({ 'x>y': fade });
    expect(withoutLostTransitions({ ...list('a', 'x'), transitions: { 'x>y': fade } })).not.toHaveProperty('transitions');
  });
});

describe('acceptPlaylists', () => {
  it('keeps playlists and drops fields that are not theirs', () => {
    expect(acceptPlaylists([{ id: 'a', name: 'A', extra: 1, tracks: [{ ...song('x'), cover: 'http://x', lyrics: [] }] }])).toEqual([list('a', 'x')].map((p) => ({ ...p, name: 'A' })));
  });

  it('refuses anything misshapen, repeated or too long', () => {
    expect(acceptPlaylists('no')).toBeNull();
    expect(acceptPlaylists([{ id: 'a' }])).toBeNull();
    expect(acceptPlaylists([list('a'), list('a')])).toBeNull();
    expect(acceptPlaylists([{ ...list('a'), name: 'n'.repeat(81) }])).toBeNull();
    expect(acceptPlaylists([list('a', 'x'.repeat(2001))])).toBeNull();
    expect(acceptPlaylists(Array.from({ length: 501 }, (_, i) => list(`p${i}`)))).toBeNull();
  });
});
