import { mkdirSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library } from './library';
import { MAX_LYRICS_BYTES, encodeTrackId } from './paths';
import { fakeFlac, removeDir, tempDir, writeFile } from './test-helpers';

let dir: string;
let root: string;

beforeEach(() => {
  dir = tempDir();
  root = path.join(dir, 'music');
  mkdirSync(root);
});
afterEach(() => removeDir(dir));

const library = (log: string[] = []): Library => new Library([{ name: 'main', dir: root }], (message) => log.push(message));
const listing = (): string[] => (readdirSync(root, { recursive: true }) as string[]).sort();

describe('Library', () => {
  it('lists audio files with their tags, and falls back to the file name', async () => {
    writeFile(path.join(root, 'Midori Vale', 'Night Market', '03 Paper Lanterns.flac'), fakeFlac(['TITLE=Paper Lanterns', 'ARTIST=Midori Vale', 'ALBUM=Night Market', 'TRACKNUMBER=3/9', 'DISCNUMBER=1']));
    writeFile(path.join(root, 'Loose Song.MP3'), Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]));
    writeFile(path.join(root, 'cover.jpg'), 'not audio');
    writeFile(path.join(root, 'notes.txt'), 'not audio');
    const before = listing();

    const lib = library();
    expect(lib.scannedAt).toBeNull();
    await lib.scan();

    expect(lib.scannedAt).not.toBeNull();
    expect(lib.tracks).toEqual([
      { id: encodeTrackId('main', ['Loose Song.MP3']), title: 'Loose Song', artist: '', album: '', trackNumber: null, discNumber: null, durationSeconds: null, lyrics: [] },
      {
        id: encodeTrackId('main', ['Midori Vale', 'Night Market', '03 Paper Lanterns.flac']),
        title: 'Paper Lanterns', artist: 'Midori Vale', album: 'Night Market', trackNumber: 3, discNumber: 1, durationSeconds: 10, lyrics: [],
      },
    ]);
    // The library is only read.
    expect(listing()).toEqual(before);
  });

  it('gives a file the same id on every scan: the base64url of root name and path', async () => {
    writeFile(path.join(root, 'Tin Harbor', 'Low Tide.flac'), fakeFlac(['TITLE=Low Tide']));
    const expected = Buffer.from('main/Tin Harbor/Low Tide.flac').toString('base64url');
    const lib = library();
    await lib.scan();
    expect(lib.tracks[0].id).toBe(expected);
    await lib.scan();
    expect(lib.tracks.map((track) => track.id)).toEqual([expected]);

    const other = new Library([{ name: 'other', dir: root }]);
    await other.scan();
    expect(other.tracks[0].id).not.toBe(expected);
  });

  it('finds the lyrics beside a song, sorted by name', async () => {
    const album = path.join(root, 'Night Market');
    writeFile(path.join(album, 'Paper Lanterns.flac'), fakeFlac(['TITLE=Paper Lanterns']));
    writeFile(path.join(album, 'Paper Lanterns.lrc'), '[00:01.00]one');
    writeFile(path.join(album, 'paper lanterns.ja-Latn.json'), '{}');
    writeFile(path.join(album, 'Paper Lanterns_en.TTML'), '<tt/>');
    writeFile(path.join(album, 'Paper Lanterns Reprise.lrc'), 'another song');
    writeFile(path.join(album, 'Paper Lanterns.txt'), 'not lyrics');
    writeFile(path.join(album, 'Paper Lanterns.huge.lrc'), Buffer.alloc(MAX_LYRICS_BYTES + 1, 0x20));
    writeFile(path.join(root, 'Paper Lanterns.lrc'), 'in another folder');

    const lib = library();
    await lib.scan();
    const [track] = lib.tracks;
    expect(track.lyrics).toEqual([
      { index: 0, name: 'Paper Lanterns.lrc', format: 'lrc' },
      { index: 1, name: 'Paper Lanterns_en.TTML', format: 'ttml' },
      { index: 2, name: 'paper lanterns.ja-Latn.json', format: 'json' },
    ]);
  });

  it('gives lyrics two songs match by name to the song with the longer name', async () => {
    writeFile(path.join(root, 'Kite.flac'), fakeFlac(['TITLE=Kite']));
    writeFile(path.join(root, 'Kite_live.flac'), fakeFlac(['TITLE=Kite (Live)']));
    writeFile(path.join(root, 'Kite.lrc'), 'studio');
    writeFile(path.join(root, 'Kite_live.lrc'), 'live');
    writeFile(path.join(root, 'Kite_en.lrc'), 'studio, English');

    const lib = library();
    await lib.scan();
    const names = Object.fromEntries(lib.tracks.map((track) => [track.title, track.lyrics.map((file) => file.name)]));
    expect(names).toEqual({ Kite: ['Kite.lrc', 'Kite_en.lrc'], 'Kite (Live)': ['Kite_live.lrc'] });
  });

  it('sorts by artist, album, disc, track number, then title', async () => {
    const song = (file: string, ...comments: string[]): void => writeFile(path.join(root, file), fakeFlac(comments));
    song('a.flac', 'ARTIST=Tin Harbor', 'ALBUM=Low Tide', 'TRACKNUMBER=1', 'TITLE=Gulls');
    song('b.flac', 'ARTIST=Midori Vale', 'ALBUM=Night Market', 'DISCNUMBER=2', 'TRACKNUMBER=1', 'TITLE=Dawn Stalls');
    song('c.flac', 'ARTIST=Midori Vale', 'ALBUM=Night Market', 'DISCNUMBER=1', 'TRACKNUMBER=10', 'TITLE=Closing Bell');
    song('d.flac', 'ARTIST=Midori Vale', 'ALBUM=Night Market', 'DISCNUMBER=1', 'TRACKNUMBER=2', 'TITLE=Paper Lanterns');
    song('e.flac', 'ARTIST=midori vale', 'ALBUM=Ferry Songs', 'TITLE=Wake');
    song('f.flac', 'ARTIST=midori vale', 'ALBUM=Ferry Songs', 'TITLE=Anchor');
    song('g.flac', 'TITLE=Untagged Artist');

    const lib = library();
    await lib.scan();
    expect(lib.tracks.map((track) => track.title)).toEqual(['Untagged Artist', 'Anchor', 'Wake', 'Paper Lanterns', 'Closing Bell', 'Dawn Stalls', 'Gulls']);
  });

  it('skips dot-folders and dot-files, and stops 8 folders down', async () => {
    writeFile(path.join(root, '.trash', 'Hidden.flac'), fakeFlac(['TITLE=Hidden']));
    writeFile(path.join(root, '._Resource.flac'), fakeFlac(['TITLE=Resource Fork']));
    writeFile(path.join(root, '@eaDir', 'Thumb.flac'), fakeFlac(['TITLE=Thumb']));
    const eight = path.join(root, '1', '2', '3', '4', '5', '6', '7', '8');
    writeFile(path.join(eight, 'Deep.flac'), fakeFlac(['TITLE=Deep']));
    writeFile(path.join(eight, '9', 'Too Deep.flac'), fakeFlac(['TITLE=Too Deep']));

    const lib = library();
    await lib.scan();
    expect(lib.tracks.map((track) => track.title)).toEqual(['Deep']);
  });

  it('never follows a link out of the root', async () => {
    const outside = path.join(dir, 'elsewhere');
    writeFile(path.join(outside, 'Private.flac'), fakeFlac(['TITLE=Private']));
    writeFile(path.join(root, 'Inside', 'Kept.flac'), fakeFlac(['TITLE=Kept']));
    try {
      symlinkSync(outside, path.join(root, 'link-out'), 'junction');
      symlinkSync(path.join(root, 'Inside'), path.join(root, 'link-in'), 'junction');
    } catch {
      return; // Links can't be made here (Windows without the right); nothing to test.
    }
    const lib = library();
    await lib.scan();
    // The folder linked from inside the root is listed once, not once per name.
    expect(lib.tracks.map((track) => track.title)).toEqual(['Kept']);
  });

  it('keeps a root\'s tracks when the root goes missing or empty, and drops a song that was removed', async () => {
    writeFile(path.join(root, 'Gulls.flac'), fakeFlac(['TITLE=Gulls']));
    writeFile(path.join(root, 'Wake.flac'), fakeFlac(['TITLE=Wake']));
    const log: string[] = [];
    const lib = library(log);
    await lib.scan();
    expect(lib.tracks).toHaveLength(2);

    rmSync(path.join(root, 'Wake.flac'));
    await lib.scan();
    expect(lib.tracks.map((track) => track.title)).toEqual(['Gulls']);
    const first = lib.scannedAt;

    renameSync(root, path.join(dir, 'unmounted'));
    await lib.scan();
    expect(lib.tracks.map((track) => track.title)).toEqual(['Gulls']);
    expect(log.join('\n')).toMatch(/can't read "main".*keeping its 1 tracks/);

    mkdirSync(root); // The mount point of a drive that isn't mounted.
    await lib.scan();
    expect(lib.tracks.map((track) => track.title)).toEqual(['Gulls']);
    expect(Date.parse(lib.scannedAt!)).toBeGreaterThanOrEqual(Date.parse(first!));

    writeFile(path.join(root, 'Anchor.flac'), fakeFlac(['TITLE=Anchor']));
    await lib.scan();
    expect(lib.tracks.map((track) => track.title)).toEqual(['Anchor']);
  });

  it('reads tags again when a file changes', async () => {
    const file = path.join(root, 'Song.flac');
    writeFile(file, fakeFlac(['TITLE=First Name']));
    const lib = library();
    await lib.scan();
    writeFile(file, fakeFlac(['TITLE=A Second, Longer Name']));
    await lib.scan();
    expect(lib.tracks[0].title).toBe('A Second, Longer Name');
  });
});
