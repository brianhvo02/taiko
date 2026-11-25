import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LibraryPaths, decodeTrackId, encodeTrackId, listFolder } from './paths';
import { fakeFlac, removeDir, tempDir, writeFile } from './test-helpers';

let dir: string;
let root: string;
let paths: LibraryPaths;

const id = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

beforeAll(() => {
  dir = tempDir();
  root = path.join(dir, 'music');
  const song = fakeFlac(['TITLE=Low Tide']);
  writeFile(path.join(root, 'Albums', 'Tin Harbor', 'Low Tide.flac'), song);
  writeFile(path.join(root, 'Albums', 'Tin Harbor', 'Low Tide.lrc'), '[00:01.00]low tide');
  writeFile(path.join(root, 'Albums', 'Tin Harbor', 'Low Tide.ja.lrc'), '[00:01.00]干潮');
  writeFile(path.join(root, 'Albums', 'Tin Harbor', 'cover.jpg'), 'a picture');
  writeFile(path.join(root, 'Albums', 'Tin Harbor', '.Low Tide.flac'), song);
  writeFile(path.join(root, 'Albums', '紙の灯籠.mp3'), song);
  writeFile(path.join(root, '.hidden', 'Song.flac'), song);
  writeFile(path.join(root, '@eaDir', 'Song.flac'), song);
  writeFile(path.join(root, '#recycle', 'Song.flac'), song);
  writeFile(path.join(root, '$RECYCLE.BIN', 'Song.flac'), song);
  mkdirSync(path.join(root, 'Folder.flac'));
  // Beside the root, with a name the root's own name is a prefix of.
  writeFile(path.join(dir, 'music2', 'Private.flac'), song);
  writeFile(path.join(dir, 'data', 'secret.key'), 'a secret');
  paths = new LibraryPaths([{ name: 'main', dir: root }, { name: 'Second Shelf', dir: path.join(dir, 'music2') }]);
});

afterAll(() => removeDir(dir));

describe('track ids', () => {
  it('are the base64url of root name and path, and decode back', () => {
    expect(encodeTrackId('main', ['Albums', 'Tin Harbor', 'Low Tide.flac'])).toBe(id('main/Albums/Tin Harbor/Low Tide.flac'));
    expect(decodeTrackId(id('main/Albums/紙の灯籠.mp3'))).toBe('main/Albums/紙の灯籠.mp3');
    expect(encodeTrackId('main', ['a.flac'])).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('are refused when they are not base64url of UTF-8, or not spelled the one way', () => {
    expect(decodeTrackId('')).toBeNull();
    expect(decodeTrackId('bWFpbi9h+/==')).toBeNull();
    expect(decodeTrackId('main/a.flac')).toBeNull();
    expect(decodeTrackId(Buffer.from([0xff, 0xfe, 0x41]).toString('base64url'))).toBeNull();
    expect(decodeTrackId('YWI')).toBe('ab');
    expect(decodeTrackId('YWJ')).toBeNull(); // the same bytes, with stray bits in the last character
    expect(decodeTrackId('A'.repeat(5000))).toBeNull();
  });
});

describe('LibraryPaths.resolveTrack', () => {
  it('finds a file by its id', async () => {
    const track = await paths.resolveTrack(id('main/Albums/Tin Harbor/Low Tide.flac'));
    expect(track?.audioPath).toBe(realpathSync(path.join(root, 'Albums', 'Tin Harbor', 'Low Tide.flac')));
    expect(track?.name).toBe('Low Tide.flac');
    expect((await paths.resolveTrack(id('main/Albums/紙の灯籠.mp3')))?.name).toBe('紙の灯籠.mp3');
    expect((await paths.resolveTrack(id('Second Shelf/Private.flac')))?.name).toBe('Private.flac');
  });

  it.each([
    // climbing out
    'main/../music2/Private.flac',
    'main/Albums/../../music2/Private.flac',
    'main/Albums/../../data/secret.key',
    'main/..',
    '../music2/Private.flac',
    '..',
    // parts that aren't names
    'main/./Albums/Tin Harbor/Low Tide.flac',
    'main//Albums/Tin Harbor/Low Tide.flac',
    'main/Albums/Tin Harbor/Low Tide.flac/',
    '/main/Albums/Tin Harbor/Low Tide.flac',
    // encoded tricks, which are just names that don't exist
    'main/%2e%2e/music2/Private.flac',
    'main/..%2Fmusic2%2FPrivate.flac',
    'main%2FAlbums%2FTin Harbor%2FLow Tide.flac',
    'main/Albums/Tin Harbor/Low Tide.flac\0',
    'main/Albums/Tin Harbor/Low Tide.flac\0.flac',
    'main/\0/Low Tide.flac',
    // backslashes and drives
    'main\\Albums\\Tin Harbor\\Low Tide.flac',
    'main/Albums\\Tin Harbor/Low Tide.flac',
    'main/..\\music2\\Private.flac',
    'main/..\\..\\music2/Private.flac',
    'C:/Windows/win.flac',
    'main/C:/Windows/win.flac',
    'main/C:Private.flac',
    '\\\\server\\share\\a.flac',
    // a root name that only starts like one, or isn't one
    'main2/Private.flac',
    'mai/Albums/Tin Harbor/Low Tide.flac',
    'MAIN/Albums/Tin Harbor/Low Tide.flac',
    'music2/Private.flac',
    'other/Albums/Tin Harbor/Low Tide.flac',
    // names the server never lists
    'main/.hidden/Song.flac',
    'main/@eaDir/Song.flac',
    'main/#recycle/Song.flac',
    'main/#Recycle/Song.flac',
    'main/$RECYCLE.BIN/Song.flac',
    'main/Albums/Tin Harbor/.Low Tide.flac',
    // not an audio file
    'main/Albums/Tin Harbor/cover.jpg',
    'main/Albums/Tin Harbor/Low Tide.lrc',
    'main/Albums/Tin Harbor',
    'main/Folder.flac',
    'main',
    'main/',
    // not there
    'main/Albums/Tin Harbor/High Tide.flac',
    'main/Nowhere/Low Tide.flac',
  ])('refuses %j', async (text) => {
    expect(await paths.resolveTrack(id(text))).toBeNull();
  });

  it('refuses absolute paths, raw paths and ids encoded twice', async () => {
    const file = path.join(root, 'Albums', 'Tin Harbor', 'Low Tide.flac');
    for (const text of [file, file.replaceAll('\\', '/'), path.join(dir, 'music2', 'Private.flac'), `main/${file}`]) {
      expect(await paths.resolveTrack(id(text))).toBeNull();
    }
    expect(await paths.resolveTrack('main/Albums/Tin Harbor/Low Tide.flac')).toBeNull();
    expect(await paths.resolveTrack(id(id('main/Albums/Tin Harbor/Low Tide.flac')))).toBeNull();
    expect(await paths.resolveTrack('')).toBeNull();
    expect(await paths.resolveTrack('!!!')).toBeNull();
  });

  it('follows a link only while it stays inside the root', async () => {
    try {
      symlinkSync(path.join(dir, 'music2'), path.join(root, 'link-out'), 'junction');
      symlinkSync(path.join(root, 'Albums', 'Tin Harbor'), path.join(root, 'link-in'), 'junction');
    } catch {
      return; // Links can't be made here (Windows without the right); nothing to test.
    }
    expect(await paths.resolveTrack(id('main/link-out/Private.flac'))).toBeNull();
    expect(await paths.resolveFolder('main/link-out')).toBeNull();
    const inner = await paths.resolveTrack(id('main/link-in/Low Tide.flac'));
    expect(inner?.audioPath).toBe(realpathSync(path.join(root, 'Albums', 'Tin Harbor', 'Low Tide.flac')));
    // The listing leaves the outward link out and keeps the inward one.
    const listing = await listFolder(realpathSync(root), realpathSync(root));
    expect(listing.folders.map((folder) => folder.name)).toEqual(['Albums', 'Folder.flac', 'link-in']);
  });
});

describe('LibraryPaths.resolveFolder', () => {
  it('finds roots and folders under them', async () => {
    expect((await paths.resolveFolder('main'))?.real).toBe(realpathSync(root));
    const folder = await paths.resolveFolder('main/Albums/Tin Harbor');
    expect(folder?.real).toBe(realpathSync(path.join(root, 'Albums', 'Tin Harbor')));
    expect(folder?.parts).toEqual(['Albums', 'Tin Harbor']);
    expect(folder?.root.name).toBe('main');
  });

  it.each([
    '', '/', 'main/', '/main', 'main/..', 'main/../music2', 'main/Albums/..', 'main/.', 'main//Albums', 'main\\Albums',
    'main/Albums/Tin Harbor/Low Tide.flac', 'main/Nowhere', 'main2', 'music', 'main/.hidden', 'main/@eaDir', 'main/#recycle',
    'main/$RECYCLE.BIN', 'C:', 'main/C:', '..', '.',
  ])('refuses %j', async (text) => {
    expect(await paths.resolveFolder(text)).toBeNull();
  });

  it('refuses a root whose folder is missing', async () => {
    const gone = new LibraryPaths([{ name: 'gone', dir: path.join(dir, 'not-mounted') }]);
    expect(await gone.resolveFolder('gone')).toBeNull();
    expect(await gone.resolveTrack(id('gone/Song.flac'))).toBeNull();
  });
});

describe('lyrics of a resolved track', () => {
  it('are the ones the folder listing gives the song, in the same order', async () => {
    const track = (await paths.resolveTrack(id('main/Albums/Tin Harbor/Low Tide.flac')))!;
    const lyrics = await paths.lyricsOf(track);
    expect(lyrics.map((file) => file.name)).toEqual(['Low Tide.ja.lrc', 'Low Tide.lrc']);
    const listing = await listFolder(track.folder.real, track.folder.rootReal);
    expect(listing.audio.map((song) => song.name)).toEqual(['Low Tide.flac']);
    expect(listing.audio[0].lyrics).toEqual(lyrics);
    expect(await paths.lyricsOf((await paths.resolveTrack(id('main/Albums/紙の灯籠.mp3')))!)).toEqual([]);
  });
});
