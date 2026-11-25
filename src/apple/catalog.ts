/**
 * Apple's public catalog (the iTunes Search API): looks a song up by its Apple Music ID or by name. No key or
 * sign-in. It returns names, art and IDs, never lyrics. Names differ per country's storefront, so a song is looked
 * up in the storefront of its lyrics' language and in the US one.
 */

export interface AppleSong {
  kind?: string;
  trackId: number;
  trackName: string;
  artistName: string;
  collectionName: string;
  trackTimeMillis: number;
  artworkUrl60?: string;
  artworkUrl100?: string;
  trackViewUrl?: string;
}

export interface Identified {
  /** The song as its home storefront names it. */
  song: AppleSong | null;
  /** The same song in the US catalog, when the home storefront is another country. */
  us: AppleSong | null;
}

export const COUNTRIES: Record<string, string> = {
  jp: 'Japan', us: 'United States', gb: 'United Kingdom', kr: 'South Korea', tw: 'Taiwan',
  fr: 'France', de: 'Germany', es: 'Spain', it: 'Italy', br: 'Brazil',
};

const STOREFRONT: Record<string, string> = { ja: 'jp', ko: 'kr', zh: 'tw', en: 'us', es: 'es', fr: 'fr', de: 'de', it: 'it', pt: 'br' };

/** The storefront matching a lyrics language such as "ja" or "en-US", or '' when there is no obvious one. */
export const storefrontFor = (language: string): string => STOREFRONT[language.slice(0, 2).toLowerCase()] ?? '';

export function browserRegion(): string {
  const region = (navigator.language.split('-')[1] ?? '').toLowerCase();
  return /^[a-z]{2}$/.test(region) ? region : '';
}

interface Results {
  results?: AppleSong[];
}

/** A page opened from disk sends no usable origin, and Apple then leaves out its CORS header: fall back to JSONP. */
function viaScript(url: string): Promise<Results> {
  return new Promise((resolve, reject) => {
    const name = `taikoLookup${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const callbacks = window as unknown as Record<string, unknown>;
    const script = document.createElement('script');
    const finish = () => { delete callbacks[name]; script.remove(); };
    callbacks[name] = (data: Results) => { finish(); resolve(data); };
    script.onerror = () => { finish(); reject(new Error('lookup failed')); };
    script.src = `${url}&callback=${name}`;
    document.head.append(script);
  });
}

const appleJson = (url: string): Promise<Results> =>
  fetch(url).then((r) => r.json() as Promise<Results>).catch(() => viaScript(url));

const songsIn = (data: Results): AppleSong[] => (data.results ?? []).filter((result) => result.kind === 'song');

export async function lookUp(id: string | number, country: string): Promise<AppleSong | null> {
  return songsIn(await appleJson(`https://itunes.apple.com/lookup?id=${id}&country=${country}`))[0] ?? null;
}

export async function searchSongs(term: string, country: string): Promise<AppleSong[]> {
  return songsIn(await appleJson(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${country}&media=music&entity=song&limit=8`));
}

/** Finds a song by ID in the lyrics' home storefront and the US one, then anywhere else likely. */
export async function identify(id: string, language: string): Promise<Identified> {
  const home = storefrontFor(language) === 'us' ? '' : storefrontFor(language);
  let [local, us] = await Promise.all([home ? lookUp(id, home) : null, lookUp(id, 'us')]);
  if (!local && !us) {
    for (const country of new Set([browserRegion(), 'jp', 'gb'].filter((c) => c && c !== home && c !== 'us'))) {
      local = await lookUp(id, country);
      if (local) break;
    }
  }
  return { song: local ?? us, us: local ? us : null };
}

/** After a search pick: the same song under its other name (US when picked elsewhere, home when picked in the US). */
export async function counterpart(song: AppleSong, country: string, language: string): Promise<Identified> {
  const home = storefrontFor(language);
  if (country !== 'us') return { song, us: await lookUp(song.trackId, 'us') };
  if (home && home !== 'us') {
    const local = await lookUp(song.trackId, home);
    if (local) return { song: local, us: song };
  }
  return { song, us: null };
}
