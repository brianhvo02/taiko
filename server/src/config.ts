/**
 * The server's settings, all from environment variables. `loadConfig` throws a `ConfigError` whose message says what
 * to set; `main.ts` prints it and exits.
 */
import path from 'node:path';

export interface LibraryRoot {
  /** The first part of every path and track id under this root, so renaming a root changes its ids. */
  name: string;
  /** Absolute path of the folder. */
  dir: string;
}

export interface Config {
  /** `PUBLIC_BASE`: this server's API as devices reach it. Always ends in `/api/`. */
  publicBase: string;
  /** The path of `publicBase` (`/api/`, `/taiko/api/`), where the routes are mounted. */
  basePath: string;
  /** `LIBRARY_ROOTS`. Empty for the subcommands, which don't need the library. */
  roots: LibraryRoot[];
  dataDir: string;
  port: number;
  serverName: string;
  /** `APP_URL`: the players allowed to call this server. Pairing links open the first. */
  appUrls: string[];
  /** The origins of `appUrls`, the only ones CORS allows besides localhost. */
  appOrigins: string[];
  /** `LIBRARY_SCAN`: whether the tag-based library is built. Off by default; the folder browser needs no scan. */
  libraryScan: boolean;
  /** Minutes between library scans while `libraryScan` is on; 0 scans only at start. */
  scanIntervalMinutes: number;
}

export class ConfigError extends Error {}

export type Env = Record<string, string | undefined>;

export const DEFAULT_APP_URL = 'https://taiko-player.pages.dev/';
export const DEFAULT_PORT = 8080;
export const DEFAULT_SERVER_NAME = 'Taiko NAS';
export const DEFAULT_SCAN_INTERVAL_MINUTES = 360;

function value(env: Env, key: string): string {
  return (env[key] ?? '').trim();
}

function httpUrl(text: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(`${what} is not a URL: "${text}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`${what} must start with https:// or http://, got "${text}".`);
  }
  return url;
}

function parsePublicBase(env: Env): URL {
  const text = value(env, 'PUBLIC_BASE');
  if (!text) {
    throw new ConfigError(
      'PUBLIC_BASE is not set. Set it to the address devices reach this server at, ending in /api/, ' +
        'for example PUBLIC_BASE=https://music.example.com/api/',
    );
  }
  const url = httpUrl(text, 'PUBLIC_BASE');
  if (!url.pathname.endsWith('/api/')) {
    throw new ConfigError(`PUBLIC_BASE must end in /api/ (for example https://music.example.com/api/), got "${text}".`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new ConfigError(`PUBLIC_BASE must be a plain address with no query, fragment or login, got "${text}".`);
  }
  return url;
}

export function parseLibraryRoots(text: string): LibraryRoot[] {
  const example = 'for example LIBRARY_ROOTS=Music=/library/music,Singles=/library/singles';
  const roots: LibraryRoot[] = [];
  for (const part of text.split(',')) {
    const pair = part.trim();
    if (!pair) continue;
    const equals = pair.indexOf('=');
    const name = equals > 0 ? pair.slice(0, equals).trim() : '';
    const dir = equals > 0 ? pair.slice(equals + 1).trim() : '';
    if (!name || !dir) {
      throw new ConfigError(`LIBRARY_ROOTS has "${pair}", which is not a name=folder pair; ${example}`);
    }
    // The name is the first part of every browse path and track id, where "/" separates folders.
    if (/[\\/\0]/.test(name) || name === '.' || name === '..') {
      throw new ConfigError(`LIBRARY_ROOTS names a root "${name}"; a root's name can't contain a slash or be "." or "..".`);
    }
    if (roots.some((root) => root.name === name)) {
      throw new ConfigError(`LIBRARY_ROOTS names the root "${name}" twice; give each folder its own name.`);
    }
    roots.push({ name, dir: path.resolve(dir) });
  }
  if (!roots.length) {
    throw new ConfigError(`LIBRARY_ROOTS is not set. Set it to name=folder pairs separated by commas, ${example}`);
  }
  return roots;
}

function parseWholeNumber(env: Env, key: string, fallback: number, min: number, max: number): number {
  const text = value(env, key);
  if (!text) return fallback;
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new ConfigError(`${key} must be a whole number from ${min} to ${max}, got "${text}".`);
  }
  return n;
}

function parseSwitch(env: Env, key: string, fallback: boolean): boolean {
  const text = value(env, key).toLowerCase();
  if (!text) return fallback;
  if (text !== 'on' && text !== 'off') throw new ConfigError(`${key} must be on or off, got "${value(env, key)}".`);
  return text === 'on';
}

function parseAppUrls(env: Env): string[] {
  const text = value(env, 'APP_URL') || DEFAULT_APP_URL;
  const urls = text.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const url = httpUrl(part, 'APP_URL');
    url.hash = '';
    return url.href;
  });
  if (!urls.length) throw new ConfigError('APP_URL is empty. Set it to the player\'s address, or leave it unset for the default.');
  return urls;
}

/** `library: false` is for the subcommands (`invite`, `devices`, `unpair`), which work without `LIBRARY_ROOTS`. */
export function loadConfig(env: Env, options: { library: boolean } = { library: true }): Config {
  const publicBase = parsePublicBase(env);
  const appUrls = parseAppUrls(env);
  return {
    publicBase: publicBase.href,
    basePath: publicBase.pathname,
    roots: options.library ? parseLibraryRoots(value(env, 'LIBRARY_ROOTS')) : [],
    dataDir: path.resolve(value(env, 'DATA_DIR') || './data'),
    port: parseWholeNumber(env, 'PORT', DEFAULT_PORT, 1, 65535),
    serverName: value(env, 'SERVER_NAME') || DEFAULT_SERVER_NAME,
    appUrls,
    appOrigins: [...new Set(appUrls.map((url) => new URL(url).origin))],
    libraryScan: parseSwitch(env, 'LIBRARY_SCAN', false),
    scanIntervalMinutes: parseWholeNumber(env, 'SCAN_INTERVAL_MINUTES', DEFAULT_SCAN_INTERVAL_MINUTES, 0, 525600),
  };
}
