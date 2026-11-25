import { describe, expect, it } from 'vitest';
import { pathOfTrackId, trackIdOf } from '../shared/api';
import { folderOf, parseRoute, routeUrl } from './route';
import type { Route } from './route';

describe('routes', () => {
  const awkward = 'Downloads/[2026.10.14] 夜市 #1 100%?／Night Market/01. 紙の灯籠.flac';

  it('reads the first screen from anything that is not a NAS path', () => {
    for (const path of ['/', '', '/index.html', '/nas/play', '/nas/play/', '/nasty', '/nas/other/x', '/nas/folders/%E0%A4%A']) {
      expect(parseRoute(path), path).toEqual({ kind: 'home' });
    }
  });

  it('reads the roots, folders and songs', () => {
    expect(parseRoute('/nas')).toEqual({ kind: 'folders', path: '' });
    expect(parseRoute('/nas/folders/')).toEqual({ kind: 'folders', path: '' });
    expect(parseRoute('/nas/folders/Music/Midori%20Vale')).toEqual({ kind: 'folders', path: 'Music/Midori Vale' });
    expect(parseRoute('/nas/play/Music/a/2%20-%20b.flac', '?t=31')).toEqual({ kind: 'play', path: 'Music/a/2 - b.flac', at: 31 });
    expect(parseRoute('/nas/play/Music/a.flac', '?t=nope')).toEqual({ kind: 'play', path: 'Music/a.flac', at: 0 });
  });

  it('writes an address that reads back as the same place, whatever the names hold', () => {
    const routes: Route[] = [
      { kind: 'home' },
      { kind: 'folders', path: '' },
      { kind: 'folders', path: folderOf(awkward) },
      { kind: 'play', path: awkward, at: 0 },
      { kind: 'play', path: awkward, at: 95 },
    ];
    for (const route of routes) {
      const url = new URL(routeUrl(route), 'https://player.example');
      expect(parseRoute(url.pathname, url.search), routeUrl(route)).toEqual(route);
    }
    expect(routeUrl({ kind: 'play', path: 'Music/a b.flac', at: 12.9 })).toBe('/nas/play/Music/a%20b.flac?t=12');
  });

  it('refuses a part that hides a slash', () => {
    expect(parseRoute('/nas/folders/Music%2F..%2Fsecret')).toEqual({ kind: 'home' });
  });

  it('finds the folder a song is in', () => {
    expect(folderOf('Music/a/b.flac')).toBe('Music/a');
    expect(folderOf('Music')).toBe('');
  });
});

describe('track ids', () => {
  it('are the base64url of the path, as the server writes them', () => {
    expect(trackIdOf('Music/a.flac')).toBe('TXVzaWMvYS5mbGFj');
    expect(trackIdOf('Music/Tin Harbor/Low Tide/2 - b.flac')).toBe('TXVzaWMvVGluIEhhcmJvci9Mb3cgVGlkZS8yIC0gYi5mbGFj');
    // "??>>~~" needs both of base64url's own characters, and its length needs padding that is left off.
    expect(trackIdOf('M/??>>~~.flac')).toMatch(/^[A-Za-z0-9_-]+$/);
    for (const path of ['Music/a.flac', 'Downloads/[2026.10.14] 夜市 #1／Night Market/01. 紙の灯籠.flac', 'M/??>>~~.flac']) {
      expect(pathOfTrackId(trackIdOf(path))).toBe(path);
    }
    expect(pathOfTrackId('not base64 at all!')).toBeNull();
    expect(pathOfTrackId('__4')).toBeNull(); // bytes that aren't UTF-8
  });
});
