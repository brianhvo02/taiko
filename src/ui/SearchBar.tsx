import { useEffect, useRef, useState } from 'react';
import { COUNTRIES, browserRegion, searchSongs, storefrontFor } from '../apple/catalog';
import type { AppleSong } from '../apple/catalog';
import type { Snapshot } from '../player/store';
import { store } from '../player/store';
import { formatTime } from './format';

type Results = { kind: 'closed' } | { kind: 'message'; text: string } | { kind: 'songs'; songs: AppleSong[]; country: string };

/** Finds a song in Apple's catalog by name, to name the open song or to read its Apple Music ID. */
export function SearchBar({ snap }: { snap: Snapshot }) {
  const [term, setTerm] = useState('');
  const [country, setCountry] = useState(() => (COUNTRIES[browserRegion()] ? browserRegion() : 'us'));
  const [results, setResults] = useState<Results>({ kind: 'closed' });
  const countryChosen = useRef(false);
  const run = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  // The catalog to search follows the open lyrics' language until the person picks one.
  const home = storefrontFor(snap.song?.language ?? '');
  useEffect(() => {
    if (!countryChosen.current && COUNTRIES[home]) setCountry(home);
  }, [home]);

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setResults({ kind: 'closed' });
    };
    addEventListener('click', close);
    addEventListener('keydown', close);
    return () => {
      removeEventListener('click', close);
      removeEventListener('keydown', close);
    };
  }, []);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const wanted = term.trim();
    if (!wanted) { setResults({ kind: 'closed' }); return; }
    const mine = ++run.current;
    setResults({ kind: 'message', text: 'Searching Apple Music' });
    try {
      const songs = await searchSongs(wanted, country);
      if (mine !== run.current) return;
      setResults(songs.length
        ? { kind: 'songs', songs, country }
        : { kind: 'message', text: `No songs match "${wanted}" in the ${COUNTRIES[country]} catalog. Try another country or spelling.` });
    } catch {
      if (mine === run.current) setResults({ kind: 'message', text: "Can't reach Apple's catalog. Check the connection and search again." });
    }
  }

  return (
    <div className="search" ref={box}>
      <form role="search" onSubmit={search}>
        <input type="search" value={term} onChange={(e) => setTerm(e.currentTarget.value)} placeholder="Search Apple Music" aria-label="Song title or artist" autoComplete="off" enterKeyHint="search" />
        <select value={country} aria-label="Country of the catalog to search" onChange={(e) => { countryChosen.current = true; setCountry(e.currentTarget.value); }}>
          {Object.entries(COUNTRIES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>
        <button className="plain-button" type="submit">Search</button>
      </form>
      {results.kind !== 'closed' && (
        <div className="search-results">
          {results.kind === 'message' && <p className="search-status">{results.text}</p>}
          {results.kind === 'songs' && results.songs.map((song) => (
            <div className="result" key={song.trackId}>
              <img alt="" src={song.artworkUrl60 ?? ''} />
              <div>
                <div className="name">{song.trackName}</div>
                <div className="detail">{song.artistName}, {song.collectionName}</div>
                <div className="detail">{formatTime(song.trackTimeMillis / 1000)}, Apple Music ID {song.trackId}</div>
              </div>
              {snap.currentId && (
                <button className="plain-button" type="button" onClick={() => { void store.useSong(song, results.country); setResults({ kind: 'closed' }); }}>Use this song</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
