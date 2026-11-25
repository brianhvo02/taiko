import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseLibraryRoots, parseScanRoots } from './config';

const base = { PUBLIC_BASE: 'https://music.example.com/api/', LIBRARY_ROOTS: 'Music=/library/music' };

describe('loadConfig', () => {
  it('fills in the defaults', () => {
    const config = loadConfig(base);
    expect(config).toEqual({
      publicBase: 'https://music.example.com/api/',
      basePath: '/api/',
      roots: [{ name: 'Music', dir: path.resolve('/library/music') }],
      dataDir: path.resolve('./data'),
      port: 8080,
      serverName: 'Taiko NAS',
      appUrls: ['https://taiko-player.pages.dev/'],
      appOrigins: ['https://taiko-player.pages.dev'],
      scanRoots: [],
      scanIntervalMinutes: 360,
    });
  });

  it('reads every setting', () => {
    const config = loadConfig({
      PUBLIC_BASE: 'http://nas.local:9000/taiko/api/',
      LIBRARY_ROOTS: ' Albums = /library/albums , Singles=/library/singles,',
      DATA_DIR: '/data',
      PORT: '9000',
      SERVER_NAME: 'Attic',
      APP_URL: 'https://player.example.com/taiko/#old, http://localhost:5173',
      SCAN_INTERVAL_MINUTES: '0',
    });
    expect(config.basePath).toBe('/taiko/api/');
    expect(config.roots).toEqual([
      { name: 'Albums', dir: path.resolve('/library/albums') },
      { name: 'Singles', dir: path.resolve('/library/singles') },
    ]);
    expect(config.dataDir).toBe(path.resolve('/data'));
    expect(config.port).toBe(9000);
    expect(config.serverName).toBe('Attic');
    expect(config.appUrls).toEqual(['https://player.example.com/taiko/', 'http://localhost:5173/']);
    expect(config.appOrigins).toEqual(['https://player.example.com', 'http://localhost:5173']);
    expect(config.scanIntervalMinutes).toBe(0);
  });

  it('refuses to start without PUBLIC_BASE, and says what to set', () => {
    expect(() => loadConfig({ LIBRARY_ROOTS: 'a=/b' })).toThrow(ConfigError);
    expect(() => loadConfig({ LIBRARY_ROOTS: 'a=/b' })).toThrow(/PUBLIC_BASE is not set.*\/api\//);
    expect(() => loadConfig({}, { library: false })).toThrow(/PUBLIC_BASE is not set/);
  });

  it.each([
    ['https://music.example.com/', /must end in \/api\//],
    ['https://music.example.com/api', /must end in \/api\//],
    ['ftp://music.example.com/api/', /https:\/\/ or http:\/\//],
    ['music.example.com/api/', /not a URL/],
    ['https://music.example.com/api/?x=1', /no query/],
  ])('rejects PUBLIC_BASE=%s', (value, message) => {
    expect(() => loadConfig({ ...base, PUBLIC_BASE: value })).toThrow(message);
  });

  it('needs LIBRARY_ROOTS for the server but not for the subcommands', () => {
    expect(() => loadConfig({ PUBLIC_BASE: base.PUBLIC_BASE })).toThrow(/LIBRARY_ROOTS is not set/);
    expect(loadConfig({ PUBLIC_BASE: base.PUBLIC_BASE }, { library: false }).roots).toEqual([]);
  });

  it('rejects bad library roots', () => {
    expect(() => parseLibraryRoots('/library/music')).toThrow(/not a name=folder pair/);
    expect(() => parseLibraryRoots('=/library/music')).toThrow(/not a name=folder pair/);
    expect(() => parseLibraryRoots('Music=')).toThrow(/not a name=folder pair/);
    expect(() => parseLibraryRoots('a=/x,a=/y')).toThrow(/twice/);
    expect(() => parseLibraryRoots('a/b=/x')).toThrow(/slash/);
    expect(() => parseLibraryRoots('a\\b=/x')).toThrow(/slash/);
    expect(() => parseLibraryRoots('..=/x')).toThrow(/"\.\."/);
    expect(() => parseLibraryRoots('.=/x')).toThrow(/can't contain a slash or be/);
    expect(parseLibraryRoots('My Music (2)=/x').map((root) => root.name)).toEqual(['My Music (2)']);
  });

  describe('LIBRARY_SCAN', () => {
    const three = { ...base, LIBRARY_ROOTS: 'FLAC=/library/flac,Downloads=/library/downloads,Music=/library/music' };
    const scan = (value?: string): string[] => loadConfig({ ...three, LIBRARY_SCAN: value }).scanRoots;

    it('is off unless set', () => {
      expect(scan()).toEqual([]);
      expect(scan('')).toEqual([]);
      expect(scan('off')).toEqual([]);
      expect(scan(' OFF ')).toEqual([]);
    });

    it('scans every root when on', () => {
      expect(scan('on')).toEqual(['FLAC', 'Downloads', 'Music']);
      expect(scan(' On ')).toEqual(['FLAC', 'Downloads', 'Music']);
    });

    it('scans only the roots it names', () => {
      expect(scan('Music')).toEqual(['Music']);
      // In the roots' own order, each once, whatever the list's spacing and order.
      expect(scan(' Music , FLAC,Music,')).toEqual(['FLAC', 'Music']);
      expect(parseScanRoots('My Music (2)', [{ name: 'My Music (2)', dir: '/x' }, { name: 'Other', dir: '/y' }])).toEqual(['My Music (2)']);
    });

    it('refuses a name that is not a root, and names it', () => {
      expect(() => scan('Music,Musik')).toThrow(ConfigError);
      expect(() => scan('Music,Musik')).toThrow(/LIBRARY_SCAN names "Musik", which is not a root in LIBRARY_ROOTS \(FLAC, Downloads, Music\)/);
      // Names are matched exactly.
      expect(() => scan('music')).toThrow(/names "music"/);
      for (const value of ['true', '1', 'yes', 'onn', 'on,Music']) {
        expect(() => scan(value)).toThrow(/LIBRARY_SCAN names "/);
      }
    });

    it('needs the roots either way, and is left alone by the subcommands', () => {
      // The folder browser serves the roots even with the library off.
      expect(() => loadConfig({ PUBLIC_BASE: base.PUBLIC_BASE, LIBRARY_SCAN: 'off' })).toThrow(/LIBRARY_ROOTS is not set/);
      expect(loadConfig({ PUBLIC_BASE: base.PUBLIC_BASE, LIBRARY_SCAN: 'Musik' }, { library: false }).scanRoots).toEqual([]);
    });
  });

  it('rejects bad numbers and app addresses', () => {
    expect(() => loadConfig({ ...base, PORT: '0' })).toThrow(/PORT must be a whole number/);
    expect(() => loadConfig({ ...base, PORT: 'http' })).toThrow(/PORT must be a whole number/);
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, SCAN_INTERVAL_MINUTES: '-5' })).toThrow(/SCAN_INTERVAL_MINUTES/);
    expect(() => loadConfig({ ...base, APP_URL: 'taiko-player.pages.dev' })).toThrow(/APP_URL is not a URL/);
  });
});
