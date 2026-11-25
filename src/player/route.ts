/**
 * Paths in the address bar for the NAS, so a folder or a song can be linked to and the browser's back and forward
 * buttons move between them. Songs picked on the device have no path: a file on one device means nothing on
 * another.
 *
 *   /                              the first screen, or a song from this device
 *   /nas/folders                   the NAS's roots
 *   /nas/folders/<folder path>     a folder
 *   /nas/play/<song path>?t=<s>    a song, optionally from a time in seconds
 *
 * A path is the root's name and the folders under it, as the folder browser shows them, each part URL-encoded.
 * It names a place on whichever NAS the device is paired with; a link doesn't say which NAS.
 */

export type Route =
  | { kind: 'home' }
  | { kind: 'folders'; path: string }
  | { kind: 'play'; path: string; at: number };

function decodeParts(encoded: string): string | null {
  try {
    const parts = encoded.split('/').filter(Boolean).map(decodeURIComponent);
    // A part can't hold a slash: it would name a different folder.
    return parts.some((part) => part.includes('/')) ? null : parts.join('/');
  } catch {
    return null;
  }
}

/** Reads an address. Anything that isn't a NAS path is the first screen. */
export function parseRoute(pathname: string, search = ''): Route {
  const folders = /^\/nas(?:\/folders(?:\/(.*))?)?\/?$/.exec(pathname);
  if (folders) {
    const path = decodeParts(folders[1] ?? '');
    return path === null ? { kind: 'home' } : { kind: 'folders', path };
  }
  const play = /^\/nas\/play\/(.+)$/.exec(pathname);
  if (play) {
    const path = decodeParts(play[1]);
    const at = Number(new URLSearchParams(search).get('t'));
    if (path) return { kind: 'play', path, at: Number.isFinite(at) && at > 0 ? at : 0 };
  }
  return { kind: 'home' };
}

const encodeParts = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** The address of a route. */
export function routeUrl(route: Route): string {
  if (route.kind === 'folders') return route.path ? `/nas/folders/${encodeParts(route.path)}` : '/nas/folders';
  if (route.kind === 'play') return `/nas/play/${encodeParts(route.path)}${route.at > 0 ? `?t=${Math.floor(route.at)}` : ''}`;
  return '/';
}

/** The folder a song's path is in. */
export const folderOf = (path: string): string => path.split('/').slice(0, -1).join('/');
