/*
 * Lets the player open with no connection. It keeps the page and the files the page is built from (scripts,
 * styles, fonts) as they are fetched, and answers from that copy when the network can't. It never touches a
 * request to a NAS or to Apple: those go to the network as they always did.
 *
 * The page itself is asked of the network first, so a new version shows as soon as there is a connection. The
 * files under /assets/ have their contents in their names and never change, so a kept copy is always right.
 */
const CACHE = 'taiko-shell-1';
// A kept file answers whatever headers it is asked with: a script asked for by the page and by this worker is one file.
const SAME = { ignoreVary: true };

async function keepShell() {
  const cache = await caches.open(CACHE);
  const page = await fetch('/', { cache: 'no-store' });
  if (!page.ok) throw new Error('page');
  await cache.put('/', page.clone());
  // The scripts and styles the page names, so the first visit is enough to open offline next time.
  const html = await page.text();
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]))];
  await Promise.all(assets.map((url) => cache.add(url).catch(() => undefined)));
  await Promise.all(['/favicon.svg', '/manifest.webmanifest'].map((url) => cache.add(url).catch(() => undefined)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(keepShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== CACHE && name.startsWith('taiko-shell-')) await caches.delete(name);
    await self.clients.claim();
  })());
});

async function page(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) await cache.put('/', fresh.clone());
    return fresh;
  } catch {
    // The app is served at every path, so the one kept page answers for any of them.
    return (await cache.match('/', SAME)) ?? Response.error();
  }
}

async function asset(request) {
  const cache = await caches.open(CACHE);
  const kept = await cache.match(request, SAME);
  if (kept) return kept;
  const fresh = await fetch(request);
  if (fresh.ok) await cache.put(request, fresh.clone());
  return fresh;
}

async function other(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) await cache.put(request, fresh.clone());
    return fresh;
  } catch {
    return (await cache.match(request, SAME)) ?? Response.error();
  }
}

// The page names files it fetched before this worker was in charge; they are kept too.
self.addEventListener('message', (event) => {
  const urls = Array.isArray(event.data?.keep) ? event.data.keep.filter((url) => typeof url === 'string' && url.startsWith('/assets/')) : [];
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const url of urls) if (!(await cache.match(url, SAME))) await cache.add(url).catch(() => undefined);
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') event.respondWith(page(request));
  else if (url.pathname.startsWith('/assets/')) event.respondWith(asset(request));
  else event.respondWith(other(request));
});
