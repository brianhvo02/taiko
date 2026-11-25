import { mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Tags } from '../../src/shared/tags';
import { Library, SEARCH_LIMIT, albumOf, compareAlbums } from './library';
import type { AlbumSong, LibraryAlbum } from './library';
import { encodeTrackId } from './paths';
import { TagCache } from './tag-cache';
import { fakeFlac, removeDir, tempDir, writeFile } from './test-helpers';

const NO_TAGS: Tags = { title: '', artist: '', album: '', trackNumber: null, discNumber: null, durationSeconds: 100 };
const song = (tags: Partial<Tags>, mtimeMs = 1000): AlbumSong => ({ tags: { ...NO_TAGS, ...tags }, mtimeMs });
const album = (songs: AlbumSong[], folder = 'Folder Name', cover = false): LibraryAlbum => albumOf(`Music/${folder}`, folder, songs, cover);

/** When a folder was made, as the scan reads it: from the disk where it says, else the time given. */
const made = (dir: string, otherwise: number): number => statSync(dir).birthtimeMs || otherwise;

describe('albumOf', () => {
  it('takes the album title most songs carry', () => {
    const made = album([song({ album: 'Bonus Disc' }), song({ album: 'Low Tide' }), song({ album: 'Low Tide' }), song({})]);
    expect(made.title).toBe('Low Tide');
    expect(made.path).toBe('Music/Folder Name');
    expect(made.trackCount).toBe(4);
  });

  it('takes the title that comes first in file order on a tie', () => {
    expect(album([song({ album: 'Side B' }), song({ album: 'Side A' }), song({ album: 'Side A' }), song({ album: 'Side B' })]).title).toBe('Side B');
    expect(album([song({}), song({ album: 'Side A' }), song({ album: 'Side B' })]).title).toBe('Side A');
  });

  it('falls back to the folder name when no song has an album tag', () => {
    const made = album([song({ albumRoman: 'ignored', date: '2019' }), song({})], '[2019] Untagged Rips');
    expect(made.title).toBe('[2019] Untagged Rips');
    expect(made).not.toHaveProperty('titleRoman');
    expect(made.date).toBe('2019');
  });

  it('takes the reading, the English name and the date from the songs that carry the title', () => {
    const made = album([
      song({ album: 'Bonus Disc', albumRoman: 'Wrong', albumEnglish: 'Wrong', date: '1999' }),
      song({ album: '夜市' }),
      song({ album: '夜市', albumRoman: 'Yoichi', date: '2021-03-04' }),
      song({ album: '夜市', albumRoman: 'Other', albumEnglish: 'Night Market', date: '2022' }),
    ]);
    expect(made).toMatchObject({ title: '夜市', titleRoman: 'Yoichi', titleEnglish: 'Night Market', date: '2021-03-04' });
  });

  it('leaves the optional names out, and the date empty, when the songs have none', () => {
    const made = album([song({ album: 'Low Tide', artist: 'Tin Harbor' })]);
    expect(made).toEqual({
      path: 'Music/Folder Name', title: 'Low Tide', artist: 'Tin Harbor', date: '', trackCount: 1, durationSeconds: 100, hasCover: false, addedAt: 1000,
    });
  });

  it('takes the album artist most songs carry, with its reading', () => {
    const made = album([
      song({ artist: 'Midori Vale feat. Tin Harbor', albumArtist: 'Midori Vale', artistRoman: 'wrong reading' }),
      song({ artist: 'Midori Vale', albumArtist: 'Midori Vale', albumArtistRoman: 'Vale, Midori', artistEnglish: 'Green Valley' }),
      song({ artist: 'Guest', albumArtist: 'Various' }),
    ]);
    expect(made).toMatchObject({ artist: 'Midori Vale', artistRoman: 'Vale, Midori', artistEnglish: 'Green Valley' });
  });

  it('takes the artist every song shares when none names an album artist', () => {
    const made = album([
      song({ artist: '緑谷', artistRoman: 'Midoritani', albumArtistRoman: 'not used' }),
      song({ artist: '緑谷', artistEnglish: 'Green Valley' }),
    ]);
    expect(made).toMatchObject({ artist: '緑谷', artistRoman: 'Midoritani', artistEnglish: 'Green Valley' });
  });

  it('has no artist when the songs share none: a compilation', () => {
    const made = album([song({ artist: 'Tin Harbor', artistRoman: 'Harbor', artistEnglish: 'Tin' }), song({ artist: 'Midori Vale' })]);
    expect(made.artist).toBe('');
    expect(made).not.toHaveProperty('artistRoman');
    expect(made).not.toHaveProperty('artistEnglish');
    expect(album([song({ artist: 'Tin Harbor' }), song({})]).artist).toBe('');
    expect(album([song({}), song({})]).artist).toBe('');
  });

  it('prefers a named album artist to differing song artists', () => {
    expect(album([song({ artist: 'Tin Harbor', albumArtist: 'Various Artists' }), song({ artist: 'Midori Vale', albumArtist: 'Various Artists' })]).artist).toBe('Various Artists');
  });

  it('adds up the lengths, or gives null when any is unknown', () => {
    expect(album([song({ durationSeconds: 61.5 }), song({ durationSeconds: 120 })]).durationSeconds).toBe(181.5);
    expect(album([song({ durationSeconds: 61.5 }), song({ durationSeconds: null })]).durationSeconds).toBeNull();
  });

  it('is as new as its newest song, and says whether it has a cover', () => {
    expect(album([song({}, 5000), song({}, 9000), song({}, 7000)]).addedAt).toBe(9000);
    // When its folder was made, where that is known: retagging a song changes the song's time, not this.
    expect(albumOf('Music/Folder Name', 'Folder Name', [song({}, 9000)], false, 4000).addedAt).toBe(4000);
    expect(album([song({})], 'x', true).hasCover).toBe(true);
  });
});

describe('compareAlbums', () => {
  const made = (title: string, artist: string, more: Partial<LibraryAlbum> = {}): LibraryAlbum =>
    ({ path: `Music/${title}`, title, artist, date: '', trackCount: 1, durationSeconds: null, hasCover: false, addedAt: 0, ...more });
  const order = (albums: LibraryAlbum[]): string[] => [...albums].sort(compareAlbums).map((entry) => entry.title);

  it('sorts by artist, then date, then title, with no artist last', () => {
    expect(order([
      made('Compilation', ''),
      made('Low Tide', 'tin harbor', { date: '2020' }),
      made('Gulls', 'Tin Harbor', { date: '2018-05-01' }),
      made('B Sides', 'Tin Harbor', { date: '2020' }),
      made('Night Market', 'Midori Vale', { date: '2022' }),
      made('Another Compilation', ''),
    ])).toEqual(['Night Market', 'Gulls', 'B Sides', 'Low Tide', 'Another Compilation', 'Compilation']);
  });

  it('sorts by the readings when there are any, and numbers in order', () => {
    expect(order([
      made('Zebra', 'Zed'),
      made('夜市', '緑谷', { artistRoman: 'Midoritani' }),
      made('Apples', 'Aaron'),
      made('漁港', 'Nori', { titleRoman: 'Gyokou' }),
      made('Harbor', 'Nori'),
      made('Volume 10', 'Olive'),
      made('Volume 2', 'Olive'),
    ])).toEqual(['Apples', '夜市', '漁港', 'Harbor', 'Volume 2', 'Volume 10', 'Zebra']);
  });
});

describe('Library', () => {
  let dir: string;
  let root: string;

  beforeEach(() => {
    dir = tempDir();
    root = path.join(dir, 'music');
    mkdirSync(root);
  });
  afterEach(() => removeDir(dir));

  const library = (log: string[] = []): Library => new Library([{ name: 'Music', dir: root }], new TagCache(), (message) => log.push(message));
  const scanned = async (log: string[] = []): Promise<Library> => {
    const lib = library(log);
    expect(lib.scan()).toBe(true);
    await lib.idle();
    return lib;
  };
  const listing = (): string[] => (readdirSync(root, { recursive: true }) as string[]).sort();

  it('makes an album of each folder that directly holds songs', async () => {
    const market = path.join(root, 'Midori Vale', '[2021] Night Market');
    writeFile(path.join(market, '01. Paper Lanterns.flac'), fakeFlac(['TITLE=Paper Lanterns', 'ARTIST=Midori Vale', 'ALBUM=Night Market', 'ALBUMARTIST=Midori Vale', 'DATE=2021-03-04', 'TRACKNUMBER=1']));
    writeFile(path.join(market, '02. Closing Bell.flac'), fakeFlac(['TITLE=Closing Bell', 'ARTIST=Midori Vale', 'ALBUM=Night Market', 'ALBUMARTIST=Midori Vale', 'TRACKNUMBER=2']));
    writeFile(path.join(market, '01. Paper Lanterns.lrc'), '[00:01.00]lanterns');
    writeFile(path.join(market, 'cover.jpg'), 'a picture');
    // An album inside an album's folder is an album of its own.
    writeFile(path.join(market, 'Bonus', '01. Dawn Stalls.flac'), fakeFlac(['TITLE=Dawn Stalls', 'ARTIST=Midori Vale', 'ALBUM=Night Market (Bonus)']));
    writeFile(path.join(root, 'Tin Harbor', 'Loose', 'Gulls.mp3'), Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    writeFile(path.join(root, 'Tin Harbor', 'notes.txt'), 'not audio');
    writeFile(path.join(root, 'Empty Artist', 'Empty Album', 'cover.jpg'), 'a picture');
    const when = new Date('2026-02-03T04:05:06Z');
    utimesSync(path.join(market, '02. Closing Bell.flac'), when, when);
    utimesSync(path.join(market, '01. Paper Lanterns.flac'), new Date('2025-01-01T00:00:00Z'), new Date('2025-01-01T00:00:00Z'));
    const before = listing();

    const lib = library();
    expect(lib).toMatchObject({ enabled: true, scanning: false, scannedAt: null, albums: [], tracks: [] });
    lib.scan();
    await lib.idle();

    expect(typeof lib.scannedAt).toBe('string');
    expect(lib.albums).toEqual([
      {
        path: 'Music/Midori Vale/[2021] Night Market', title: 'Night Market', artist: 'Midori Vale', date: '2021-03-04',
        trackCount: 2, durationSeconds: 20, hasCover: true, addedAt: made(market, when.getTime()),
      },
      {
        path: 'Music/Midori Vale/[2021] Night Market/Bonus', title: 'Night Market (Bonus)', artist: 'Midori Vale', date: '',
        trackCount: 1, durationSeconds: 10, hasCover: false, addedAt: made(path.join(market, 'Bonus'), statSync(path.join(market, 'Bonus', '01. Dawn Stalls.flac')).mtimeMs),
      },
      // No tags at all: named after its folder, with no artist, so it comes last. A folder of folders is no album.
      {
        path: 'Music/Tin Harbor/Loose', title: 'Loose', artist: '', date: '',
        trackCount: 1, durationSeconds: null, hasCover: false, addedAt: made(path.join(root, 'Tin Harbor', 'Loose'), statSync(path.join(root, 'Tin Harbor', 'Loose', 'Gulls.mp3')).mtimeMs),
      },
    ]);
    // The songs, as `browse` would list them, album by album.
    expect(lib.tracks).toEqual([
      {
        id: encodeTrackId('Music', ['Midori Vale', '[2021] Night Market', '01. Paper Lanterns.flac']), title: 'Paper Lanterns', artist: 'Midori Vale',
        album: 'Night Market', trackNumber: 1, discNumber: null, durationSeconds: 10, sampleRate: 44100, bitsPerSample: 16, albumArtist: 'Midori Vale', date: '2021-03-04',
        lyrics: [{ index: 0, name: '01. Paper Lanterns.lrc', format: 'lrc' }],
      },
      {
        id: encodeTrackId('Music', ['Midori Vale', '[2021] Night Market', '02. Closing Bell.flac']), title: 'Closing Bell', artist: 'Midori Vale',
        album: 'Night Market', trackNumber: 2, discNumber: null, durationSeconds: 10, sampleRate: 44100, bitsPerSample: 16, albumArtist: 'Midori Vale', lyrics: [],
      },
      {
        id: encodeTrackId('Music', ['Midori Vale', '[2021] Night Market', 'Bonus', '01. Dawn Stalls.flac']), title: 'Dawn Stalls', artist: 'Midori Vale',
        album: 'Night Market (Bonus)', trackNumber: null, discNumber: null, durationSeconds: 10, sampleRate: 44100, bitsPerSample: 16, lyrics: [],
      },
      { id: encodeTrackId('Music', ['Tin Harbor', 'Loose', 'Gulls.mp3']), title: 'Gulls', artist: '', album: '', trackNumber: null, discNumber: null, durationSeconds: null, lyrics: [] },
    ]);
    // The library is only read.
    expect(listing()).toEqual(before);
  });

  it('reads readings and English names from the tags, and sorts by the readings', async () => {
    writeFile(path.join(root, 'a', '1.flac'), fakeFlac(['TITLE=灯籠', 'ARTIST=緑谷', 'ARTISTSORT=Midoritani', 'ARTIST_EN=Green Valley', 'ALBUM=夜市', 'ALBUMSORT=Yoichi', 'ALBUM_EN=Night Market', 'DATE=2021']));
    writeFile(path.join(root, 'b', '1.flac'), fakeFlac(['TITLE=Gulls', 'ARTIST=Tin Harbor', 'ALBUM=Low Tide']));
    writeFile(path.join(root, 'c', '1.flac'), fakeFlac(['TITLE=Anchor', 'ARTIST=Anchor Line', 'ALBUM=Ferry Songs']));
    writeFile(path.join(root, 'd', '1.flac'), fakeFlac(['TITLE=Kite', 'ALBUMARTIST=凧', 'ALBUMARTISTSORT=Tako', 'ALBUM=Paper']));
    const lib = await scanned();
    expect(lib.albums.map((entry) => entry.title)).toEqual(['Ferry Songs', '夜市', 'Paper', 'Low Tide']);
    expect(lib.albums[1]).toMatchObject({ title: '夜市', titleRoman: 'Yoichi', titleEnglish: 'Night Market', artist: '緑谷', artistRoman: 'Midoritani', artistEnglish: 'Green Valley', date: '2021' });
    expect(lib.albums[2]).toMatchObject({ artist: '凧', artistRoman: 'Tako' });
  });

  it('skips dot-folders, stops 8 folders down, and never follows a link out of the root', async () => {
    writeFile(path.join(root, '.trash', 'Hidden.flac'), fakeFlac(['ALBUM=Hidden']));
    writeFile(path.join(root, '@eaDir', 'Thumb.flac'), fakeFlac(['ALBUM=Thumb']));
    const eight = path.join(root, '1', '2', '3', '4', '5', '6', '7', '8');
    writeFile(path.join(eight, 'Deep.flac'), fakeFlac(['ALBUM=Deep']));
    writeFile(path.join(eight, '9', 'Too Deep.flac'), fakeFlac(['ALBUM=Too Deep']));
    writeFile(path.join(dir, 'elsewhere', 'Private.flac'), fakeFlac(['ALBUM=Private']));
    try {
      symlinkSync(path.join(dir, 'elsewhere'), path.join(root, 'link-out'), 'junction');
      symlinkSync(path.join(root, '1'), path.join(root, 'link-in'), 'junction');
    } catch {
      // Links can't be made here (Windows without the right); the rest still holds.
    }
    const lib = await scanned();
    // The folder linked from inside the root is listed once, not once per name.
    expect(lib.albums.map((entry) => entry.title)).toEqual(['Deep']);
  });

  it('keeps a root\'s albums when the root goes missing or empty, and drops an album that was removed', async () => {
    writeFile(path.join(root, 'Low Tide', 'Gulls.flac'), fakeFlac(['ALBUM=Low Tide']));
    writeFile(path.join(root, 'Ferry Songs', 'Wake.flac'), fakeFlac(['ALBUM=Ferry Songs']));
    const log: string[] = [];
    const lib = await scanned(log);
    expect(lib.albums).toHaveLength(2);

    rmSync(path.join(root, 'Ferry Songs'), { recursive: true });
    lib.scan();
    await lib.idle();
    expect(lib.albums.map((entry) => entry.title)).toEqual(['Low Tide']);

    renameSync(root, path.join(dir, 'unmounted'));
    lib.scan();
    await lib.idle();
    expect(lib.albums.map((entry) => entry.title)).toEqual(['Low Tide']);
    expect(lib.tracks).toHaveLength(1);
    expect(log.join('\n')).toMatch(/can't read "Music".*keeping its 1 albums/);

    mkdirSync(root); // The mount point of a drive that isn't mounted.
    lib.scan();
    await lib.idle();
    expect(lib.albums.map((entry) => entry.title)).toEqual(['Low Tide']);

    writeFile(path.join(root, 'Anchor', 'Anchor.flac'), fakeFlac(['ALBUM=Anchor']));
    lib.scan();
    await lib.idle();
    expect(lib.albums.map((entry) => entry.title)).toEqual(['Anchor']);
  });

  it('reads tags again when a file changes', async () => {
    const file = path.join(root, 'Album', 'Song.flac');
    writeFile(file, fakeFlac(['ALBUM=First Name']));
    const lib = await scanned();
    writeFile(file, fakeFlac(['ALBUM=A Second, Longer Name']));
    lib.scan();
    await lib.idle();
    expect(lib.albums[0].title).toBe('A Second, Longer Name');
  });

  it('says a scan is running while it runs, and starts no second one', async () => {
    writeFile(path.join(root, 'Low Tide', 'Gulls.flac'), fakeFlac(['ALBUM=Low Tide']));
    const lib = library();
    expect(lib.scanning).toBe(false);
    expect(lib.scan()).toBe(true);
    // Nothing has been awaited: the scan has started and can't have finished.
    expect(lib.scanning).toBe(true);
    expect(lib.scan()).toBe(false);
    expect(lib.albums).toEqual([]);
    await lib.idle();
    expect(lib.scanning).toBe(false);
    expect(lib.albums).toHaveLength(1);
    expect(lib.scan()).toBe(true);
    await lib.idle();
    await lib.idle();
  });

  it('logs what a scan found only when that changed', async () => {
    writeFile(path.join(root, 'Low Tide', 'Gulls.flac'), fakeFlac(['ALBUM=Low Tide']));
    const log: string[] = [];
    const lib = await scanned(log);
    expect(log).toEqual(['library: 1 albums, 1 songs']);
    lib.scan();
    await lib.idle();
    expect(log).toHaveLength(1);
    writeFile(path.join(root, 'Low Tide', 'Wake.flac'), fakeFlac(['ALBUM=Low Tide']));
    lib.scan();
    await lib.idle();
    expect(log).toEqual(['library: 1 albums, 1 songs', 'library: 1 albums, 2 songs']);
  });

  it('is off, and never scans, with no roots', async () => {
    writeFile(path.join(root, 'Low Tide', 'Gulls.flac'), fakeFlac(['ALBUM=Low Tide', 'TITLE=Gulls']));
    const off = new Library([], new TagCache());
    expect(off.enabled).toBe(false);
    expect(off.scan()).toBe(false);
    await off.idle();
    expect(off).toMatchObject({ scanning: false, scannedAt: null, albums: [], tracks: [] });
    expect(off.search('gulls')).toEqual([]);
  });

  it('scans only the roots it is given', async () => {
    const other = path.join(dir, 'downloads');
    writeFile(path.join(root, 'Low Tide', 'Gulls.flac'), fakeFlac(['ALBUM=Low Tide']));
    writeFile(path.join(other, 'Rips', 'Wake.flac'), fakeFlac(['ALBUM=Rips']));
    const lib = new Library([{ name: 'Music', dir: root }], new TagCache());
    lib.scan();
    await lib.idle();
    expect(lib.albums.map((entry) => entry.path)).toEqual(['Music/Low Tide']);
    const both = new Library([{ name: 'Music', dir: root }, { name: 'Downloads', dir: other }], new TagCache());
    both.scan();
    await both.idle();
    expect(both.albums.map((entry) => entry.path).sort()).toEqual(['Downloads/Rips', 'Music/Low Tide']);
  });

  describe('search', () => {
    const titles = (lib: Library, query: string): string[] => lib.search(query).map((track) => track.title);

    it('finds the songs that hold every word, in any of their names', async () => {
      const market = path.join(root, 'Midori Vale', 'Night Market');
      writeFile(path.join(market, '1.flac'), fakeFlac(['TITLE=Paper Lanterns', 'ARTIST=Midori Vale', 'ALBUM=Night Market', 'ALBUMARTIST=Midori Vale']));
      writeFile(path.join(market, '2.flac'), fakeFlac(['TITLE=Closing Bell', 'ARTIST=Midori Vale feat. Tin Harbor', 'ALBUM=Night Market', 'ALBUMARTIST=Midori Vale']));
      writeFile(path.join(market, '3.flac'), fakeFlac(['TITLE=灯籠', 'TITLESORT=Tourou', 'TITLE_EN=Lantern Song', 'ARTIST=緑谷', 'ARTISTSORT=Midoritani', 'ARTIST_EN=Green Valley', 'ALBUM=夜市', 'ALBUMSORT=Yoichi', 'ALBUM_EN=Evening Stalls']));
      writeFile(path.join(root, 'Tin Harbor', 'Low Tide', '1.flac'), fakeFlac(['TITLE=Night Ferry', 'ARTIST=Tin Harbor', 'ALBUM=Low Tide']));
      writeFile(path.join(root, 'Tin Harbor', 'Low Tide', '2.flac'), fakeFlac(['TITLE=Ｆｕｌｌ Ｗｉｄｔｈ', 'ARTIST=Tin Harbor', 'ALBUM=Low Tide']));
      const lib = await scanned();

      expect(titles(lib, 'paper')).toEqual(['Paper Lanterns']);
      expect(titles(lib, 'PAPER lantern')).toEqual(['Paper Lanterns']);
      expect(titles(lib, 'paper bell')).toEqual([]);
      // Words may sit in different names: a title and an artist, an artist and an album.
      expect(titles(lib, 'bell harbor')).toEqual(['Closing Bell']);
      expect(titles(lib, '  tide   harbor ')).toEqual(['Night Ferry', 'Ｆｕｌｌ Ｗｉｄｔｈ']);
      // A reading and an English name match, for the title, the artist and the album.
      expect(titles(lib, 'tourou')).toEqual(['灯籠']);
      expect(titles(lib, 'lantern song')).toEqual(['灯籠']);
      expect(titles(lib, 'midoritani')).toEqual(['灯籠']);
      expect(titles(lib, 'green valley')).toEqual(['灯籠']);
      expect(titles(lib, 'yoichi')).toEqual(['灯籠']);
      expect(titles(lib, 'evening stalls')).toEqual(['灯籠']);
      expect(titles(lib, '灯籠')).toEqual(['灯籠']);
      // The album artist counts too.
      expect(titles(lib, 'vale bell')).toEqual(['Closing Bell']);
      // Songs with every word in the title come first; the rest follow in library order.
      expect(titles(lib, 'night')).toEqual(['Night Ferry', 'Paper Lanterns', 'Closing Bell']);
      expect(titles(lib, 'lantern')).toEqual(['Paper Lanterns', '灯籠']);
      // Full-width letters match plain ones, both ways.
      expect(titles(lib, 'full width')).toEqual(['Ｆｕｌｌ Ｗｉｄｔｈ']);
      expect(titles(lib, 'ｐａｐｅｒ')).toEqual(['Paper Lanterns']);
      expect(titles(lib, 'ＰＡＰＥＲ　ｌａｎｔｅｒｎｓ')).toEqual(['Paper Lanterns']);
      // Nothing to look for.
      expect(lib.search('')).toEqual([]);
      expect(lib.search('  \t\n ')).toEqual([]);
      expect(lib.search('　')).toEqual([]);
      // A result is the song as the browser lists it.
      expect(lib.search('tourou')[0]).toEqual({
        id: encodeTrackId('Music', ['Midori Vale', 'Night Market', '3.flac']), title: '灯籠', artist: '緑谷', album: '夜市',
        trackNumber: null, discNumber: null, durationSeconds: 10, sampleRate: 44100, bitsPerSample: 16, titleRoman: 'Tourou', artistRoman: 'Midoritani', albumRoman: 'Yoichi',
        titleEnglish: 'Lantern Song', artistEnglish: 'Green Valley', albumEnglish: 'Evening Stalls', lyrics: [],
      });
    });

    it('gives at most 50 songs, title matches first', async () => {
      for (let n = 1; n <= 30; n++) writeFile(path.join(root, 'Anchor Line', 'Signal Fires', `${n}.flac`), fakeFlac([`TITLE=Song ${n}`, 'ARTIST=Anchor Line', 'ALBUM=Signal Fires']));
      for (let n = 1; n <= 30; n++) writeFile(path.join(root, 'Tin Harbor', 'Low Tide', `${n}.flac`), fakeFlac([`TITLE=Signal ${n}`, 'ARTIST=Tin Harbor', 'ALBUM=Low Tide']));
      const lib = await scanned();
      expect(lib.tracks).toHaveLength(60);
      const found = titles(lib, 'signal');
      expect(found).toHaveLength(SEARCH_LIMIT);
      expect(SEARCH_LIMIT).toBe(50);
      // All 30 title matches (from the later album), then the first 20 of the others, each in file order.
      expect(found.slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, i) => `Signal ${i + 1}`));
      expect(found.slice(30)).toEqual(Array.from({ length: 20 }, (_, i) => `Song ${i + 1}`));
      expect(titles(lib, 'song')).toHaveLength(30);
    });
  });
});
