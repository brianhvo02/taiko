import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS, KEYS, cleanName, loadOffsets, loadPlaylists, loadSession, loadSettings, saveOffset, savePlaylists, saveSession, saveSettings,
  toSavedTrack, withMoved, withTracks, withoutTrack,
} from './persist';
import type { Playlist, SavedTrack, Store } from './persist';
import { makeOrder, nextRepeat, stepFrom } from './queue';

function memory(initial: Record<string, string> = {}): Store & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = value; },
    removeItem: (key) => { delete data[key]; },
  };
}

const song = (id: string, title = id): SavedTrack => ({ id, title, artist: 'Midori Vale', album: 'Night Market', trackNumber: null, discNumber: null, durationSeconds: 50 });
const NAS = 'https://nas.example/api/';

describe('the play order', () => {
  // A predictable "random": always picks the last candidate.
  const last = () => 0.999;

  it('is the listed order when not shuffled', () => {
    expect(makeOrder(4, false, 2)).toEqual([0, 1, 2, 3]);
    expect(makeOrder(0, true)).toEqual([]);
  });

  it('puts the open song first when shuffled, and plays every song once', () => {
    for (let run = 0; run < 50; run++) {
      const order = makeOrder(9, true, 4);
      expect(order[0]).toBe(4);
      expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    }
    expect(makeOrder(3, true, -1, last)).toHaveLength(3);
    // Over many shuffles the second place isn't always the same song.
    expect(new Set(Array.from({ length: 60 }, () => makeOrder(6, true, 0)[1])).size).toBeGreaterThan(1);
  });

  it('steps through the order and stops at its ends', () => {
    const order = [2, 0, 1];
    expect(stepFrom(order, 2, 1, 'off')).toEqual({ index: 0, wrapped: false });
    expect(stepFrom(order, 0, -1, 'off')).toEqual({ index: 2, wrapped: false });
    expect(stepFrom(order, 1, 1, 'off')).toEqual({ index: -1, wrapped: false });
    expect(stepFrom(order, 2, -1, 'off')).toEqual({ index: -1, wrapped: false });
    expect(stepFrom(order, 1, 1, 'one')).toEqual({ index: -1, wrapped: false });
    expect(stepFrom(order, 7, 1, 'all')).toEqual({ index: -1, wrapped: false });
    expect(stepFrom([], 0, 1, 'all')).toEqual({ index: -1, wrapped: false });
  });

  it('comes round when everything repeats', () => {
    const order = [2, 0, 1];
    expect(stepFrom(order, 1, 1, 'all')).toEqual({ index: 2, wrapped: true });
    expect(stepFrom(order, 2, -1, 'all')).toEqual({ index: 1, wrapped: true });
    expect(stepFrom([0], 0, 1, 'all')).toEqual({ index: 0, wrapped: true });
  });

  it('cycles repeat through off, all and one', () => {
    expect([nextRepeat('off'), nextRepeat('all'), nextRepeat('one')]).toEqual(['all', 'one', 'off']);
  });
});

describe('settings', () => {
  it('default when nothing is stored, when storage is missing, and when what is stored is nonsense', () => {
    expect(loadSettings(memory())).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(memory({ [KEYS.settings]: '{not json' }))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(memory({ [KEYS.settings]: '[1,2]' }))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(memory({ [KEYS.settings]: JSON.stringify({ repeat: 'sometimes', shuffle: 'yes', showRoman: 0, sweepLines: 'please', seekOnLine: 'no' }) }))).toEqual(DEFAULT_SETTINGS);
  });

  it('come back as they were saved', () => {
    const store = memory();
    saveSettings({ showRoman: false, showTranslation: true, repeat: 'one', shuffle: true, sweepLines: true, seekOnLine: false, levelVolume: false, crossfade: 6 }, store);
    expect(loadSettings(store)).toEqual({ showRoman: false, showTranslation: true, repeat: 'one', shuffle: true, sweepLines: true, seekOnLine: false, levelVolume: false, crossfade: 6 });
    // A setting added later is at its default in what an older visit stored.
    store.setItem(KEYS.settings, JSON.stringify({ showRoman: false, repeat: 'all' }));
    expect(loadSettings(store)).toEqual({ showRoman: false, showTranslation: true, repeat: 'all', shuffle: false, sweepLines: false, seekOnLine: true, levelVolume: true, crossfade: 0 });
  });

  it('survive a storage that refuses to write', () => {
    const full: Store = { getItem: () => null, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('no'); } };
    expect(() => saveSettings(DEFAULT_SETTINGS, full)).not.toThrow();
    expect(() => saveSession(null, full)).not.toThrow();
  });
});

describe('lyric timing', () => {
  it('is kept per song, forgotten at zero, and read back', () => {
    const store = memory();
    const offsets = loadOffsets(store);
    saveOffset(offsets, 'a', 0.15, store);
    saveOffset(offsets, 'b', -0.3, store);
    saveOffset(offsets, 'a', 0, store);
    expect(Array.from(loadOffsets(store))).toEqual([['b', -0.3]]);
    expect(Array.from(loadOffsets(memory({ [KEYS.offsets]: JSON.stringify([['x', 'soon'], ['y', 0], 5, ['z', 0.05]]) })))).toEqual([['z', 0.05]]);
  });
});

describe('stored songs', () => {
  it('keep their names and other forms, and drop anything else', () => {
    expect(toSavedTrack({ id: 'abc', title: '紙の灯籠', artist: 'x', titleRoman: 'Kami no Tourou', lyrics: [{ index: 0 }], cover: 'http://x', trackNumber: '3', durationSeconds: 50 })).toEqual({
      id: 'abc', title: '紙の灯籠', artist: 'x', album: '', trackNumber: null, discNumber: null, durationSeconds: 50, titleRoman: 'Kami no Tourou',
    });
    for (const bad of [null, 'abc', [], { title: 'no id' }, { id: '', title: 'x' }, { id: 5, title: 'x' }, { id: 'a' }]) expect(toSavedTrack(bad)).toBeNull();
  });
});

describe('playlists', () => {
  const list: Playlist = { id: 'p1', name: 'Evening', tracks: [song('a'), song('b'), song('c')] };

  it('are kept per NAS and read back, leaving out what is misshapen', () => {
    const store = memory();
    savePlaylists(NAS, [list], store);
    savePlaylists('https://other.example/api/', [{ id: 'p2', name: 'Other', tracks: [] }], store);
    expect(loadPlaylists(NAS, store)).toEqual([list]);
    expect(loadPlaylists('https://other.example/api/', store)).toEqual([{ id: 'p2', name: 'Other', tracks: [] }]);
    expect(loadPlaylists('https://nobody.example/api/', store)).toEqual([]);

    const odd = memory({ [KEYS.playlists]: JSON.stringify({ [NAS]: [{ id: 'p', name: 'Kept', tracks: [song('a'), { nope: 1 }, 7] }, { name: 'no id' }, 'text'] }) });
    expect(loadPlaylists(NAS, odd)).toEqual([{ id: 'p', name: 'Kept', tracks: [song('a')] }]);
  });

  it('add songs once each, at the end', () => {
    const more = withTracks(list, [song('b'), song('d'), song('d'), song('e')]);
    expect(more.tracks.map((track) => track.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(withTracks(list, [song('a')])).toBe(list);
  });

  it('remove and move songs, and leave the list alone when asked for the impossible', () => {
    expect(withoutTrack(list, 1).tracks.map((track) => track.id)).toEqual(['a', 'c']);
    expect(withMoved(list, 0, 1).tracks.map((track) => track.id)).toEqual(['b', 'a', 'c']);
    expect(withMoved(list, 2, -1).tracks.map((track) => track.id)).toEqual(['a', 'c', 'b']);
    expect(withMoved(list, 0, -1)).toBe(list);
    expect(withMoved(list, 2, 1)).toBe(list);
    expect(withoutTrack(list, 9)).toBe(list);
  });

  it('tidy their names', () => {
    expect(cleanName('  Late   night  ')).toBe('Late night');
    expect(cleanName('   ')).toBe('Untitled playlist');
    expect(cleanName('x'.repeat(200))).toHaveLength(80);
  });
});

describe('where the listener was', () => {
  const session = { nas: NAS, source: { kind: 'folder', path: 'Music/Midori Vale/Night Market' } as const, tracks: [song('a'), song('b')], current: 'b', position: 31.5 };

  it('comes back as saved, and is forgotten when cleared', () => {
    const store = memory();
    saveSession(session, store);
    expect(loadSession(store)).toEqual(session);
    saveSession(null, store);
    expect(loadSession(store)).toBeNull();
  });

  it('is ignored when its open song is not among its songs, or its shape is wrong', () => {
    const stored = (value: unknown) => loadSession(memory({ [KEYS.session]: JSON.stringify(value) }));
    expect(stored({ ...session, current: 'gone' })).toBeNull();
    expect(stored({ ...session, source: { kind: 'device' } })).toBeNull();
    expect(stored({ ...session, tracks: 'many' })).toBeNull();
    expect(stored({ ...session, position: -4 })?.position).toBe(0);
    expect(stored({ ...session, source: { kind: 'playlist', id: 'p1' } })?.source).toEqual({ kind: 'playlist', id: 'p1' });
    expect(stored('nothing')).toBeNull();
  });
});
