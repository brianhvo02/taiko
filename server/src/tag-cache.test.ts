import { utimesSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TagCache } from './tag-cache';
import { fakeFlac, removeDir, tempDir, writeFile } from './test-helpers';

let dir: string;
beforeEach(() => { dir = tempDir(); });
afterEach(() => removeDir(dir));

describe('TagCache', () => {
  it('reads a file\'s tags, and again when the file changes', async () => {
    const file = path.join(dir, 'song.flac');
    writeFile(file, fakeFlac(['TITLE=Slack Water', 'ARTIST=Tin Harbor', 'TRACKNUMBER=4']));
    const cache = new TagCache();
    expect(await cache.read(file)).toMatchObject({ title: 'Slack Water', artist: 'Tin Harbor', trackNumber: 4, durationSeconds: 10 });

    writeFile(file, fakeFlac(['TITLE=Neap Tide, the long version', 'ARTIST=Tin Harbor']));
    expect((await cache.read(file)).title).toBe('Neap Tide, the long version');
  });

  it('keeps what it read while the size and modified time are the same', async () => {
    const file = path.join(dir, 'song.flac');
    const when = new Date('2026-01-02T03:04:05Z');
    writeFile(file, fakeFlac(['TITLE=First']));
    utimesSync(file, when, when);
    const cache = new TagCache();
    expect((await cache.read(file)).title).toBe('First');
    // Same length, same time: the file is taken as unchanged and not read again.
    writeFile(file, fakeFlac(['TITLE=Other']));
    utimesSync(file, when, when);
    expect((await cache.read(file)).title).toBe('First');
  });

  it('gives empty tags for a file that is missing or not audio, and never throws', async () => {
    const none = { title: '', artist: '', album: '', trackNumber: null, discNumber: null, durationSeconds: null };
    writeFile(path.join(dir, 'notes.flac'), 'not a flac file at all');
    const cache = new TagCache();
    expect(await cache.read(path.join(dir, 'missing.flac'))).toEqual(none);
    expect(await cache.read(path.join(dir, 'notes.flac'))).toEqual(none);
  });

  it('reads many files in order and forgets the oldest past its limit', async () => {
    const files = Array.from({ length: 20 }, (_, i) => {
      const file = path.join(dir, `${i}.flac`);
      writeFile(file, fakeFlac([`TITLE=Song ${i}`]));
      return file;
    });
    const cache = new TagCache(5);
    expect((await cache.readAll(files, 3)).map((tags) => tags.title)).toEqual(files.map((_, i) => `Song ${i}`));
    expect((await cache.readAll(files)).map((tags) => tags.title)).toEqual(files.map((_, i) => `Song ${i}`));
  });
});
