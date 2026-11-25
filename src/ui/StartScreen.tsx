import { useEffect, useRef, useState } from 'react';
import { defaultDeviceName, normalizeBase } from '../nas/client';
import type { Snapshot } from '../player/store';
import { store } from '../player/store';
import { Library } from './Library';
import { canPickFolder, formatTime, pickFiles } from './format';

/**
 * The first screen opens with what the player does: a line being sung, filling word by word, with its
 * romanization and its translation under it. The line is made up for this screen; it is nobody's lyric.
 */
const HERO = {
  // Two phrases; on a narrow screen the line breaks between them, never inside one.
  words: [
    { text: '音が', roman: 'oto ga', seconds: 0.7, phrase: 0 },
    { text: '鳴れば', roman: 'nareba', seconds: 0.9, phrase: 0 },
    { text: '言葉が', roman: 'kotoba ga', seconds: 0.9, phrase: 1 },
    { text: '灯る', roman: 'tomoru', seconds: 1.1, phrase: 1 },
  ],
  translation: 'When the music plays, the words light up',
  leadIn: 0.8,
  hold: 2.6,
};

function HeroLine() {
  const ref = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const sung = HERO.words.reduce((sum, word) => sum + word.seconds, 0);
    const loop = HERO.leadIn + sung + HERO.hold;
    const rows = [Array.from(root.querySelectorAll<HTMLElement>('.original .w')), Array.from(root.querySelectorAll<HTMLElement>('.roman .w'))];
    const line = root.querySelector<HTMLElement>('.line');
    const show = (t: number) => {
      let begin = HERO.leadIn;
      HERO.words.forEach((word, i) => {
        const p = Math.max(0, Math.min(1, (t - begin) / word.seconds));
        for (const row of rows) row[i]?.style.setProperty('--p', p.toFixed(3));
        begin += word.seconds;
      });
      if (line) line.dataset.state = t >= HERO.leadIn ? 'active' : 'future';
    };
    // Someone who asked for less motion sees the line half sung, and still.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      show(HERO.leadIn + sung / 2);
      return;
    }
    let frame = 0;
    const started = performance.now();
    const tick = () => {
      show(((performance.now() - started) / 1000) % loop);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <h1 className="hero" ref={ref}>
      <span className="line" data-state="future">
        <span className="original" lang="ja">
          {[0, 1].map((phrase) => (
            <span className="phrase" key={phrase}>
              {HERO.words.filter((word) => word.phrase === phrase).map((word) => <span className="w" key={word.text}>{word.text}</span>)}
            </span>
          ))}
        </span>
        <span className="roman" aria-hidden="true">
          {HERO.words.map((word, i) => <span key={word.roman}>{i > 0 && ' '}<span className="w">{word.roman}</span></span>)}
        </span>
        <span className="translation">{HERO.translation}</span>
      </span>
    </h1>
  );
}

function NasWay({ snap, onShowSongs }: { snap: Snapshot; onShowSongs: () => void }) {
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState('');

  if (snap.pairing) {
    return (
      <section className="way nas">
        <h2>Music on your NAS</h2>
        <p>Paired with {snap.pairing.serverName} as {snap.pairing.deviceName}.</p>
        <div className="actions">
          <button className="plain-button primary-button" type="button" onClick={onShowSongs}>Open from NAS</button>
          <button className="plain-button" type="button" onClick={() => store.openSongs('playlists')}>Playlists</button>
          <button className="plain-button" type="button" onClick={() => void store.forgetNas()}>Forget this NAS</button>
        </div>
      </section>
    );
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const base = normalizeBase(address);
    if (!base) { setProblem('Enter the NAS address the owner gave you, starting with https://'); return; }
    if (!code.trim()) { setProblem('Enter the pairing code from the NAS owner.'); return; }
    setProblem('');
    store.proposePair({ base, code: code.trim().toUpperCase() });
  }

  return (
    <section className="way nas">
      <h2>Music on a NAS</h2>
      <p>If you or a friend run a Taiko server, open its invite link on this device. Or enter its address and a pairing code.</p>
      <form className="pair-form" onSubmit={submit}>
        <label>NAS address<input type="url" value={address} onChange={(e) => setAddress(e.currentTarget.value)} placeholder="https://nas.example.com/taiko/api/" autoComplete="off" /></label>
        <label>Pairing code<input type="text" value={code} onChange={(e) => setCode(e.currentTarget.value)} placeholder="XXXX-XXXX-XXXX" autoComplete="off" autoCapitalize="characters" /></label>
        <button className="plain-button" type="submit">Pair</button>
      </form>
      {problem && <p className="notice" role="alert">{problem}</p>}
    </section>
  );
}

/** Offers to pick up where the listener left off last time: the same queue and song, from the same moment. */
function Resume({ snap }: { snap: Snapshot }) {
  const saved = snap.resume;
  const song = saved?.tracks.find((track) => track.id === saved.current);
  if (!saved || !song) return null;
  const rest = saved.tracks.length - 1;
  return (
    <section className="resume">
      <div>
        <h2>Where you left off</h2>
        <p>
          {song.title}{song.artist && `, ${song.artist}`}, at {formatTime(saved.position)}
          {rest > 0 && ` (${rest} more ${rest === 1 ? 'song' : 'songs'} in the queue)`}
        </p>
      </div>
      <button className="plain-button primary-button" type="button" onClick={() => void store.resumeSession()}>Continue</button>
    </section>
  );
}

/**
 * The first screen. With nothing to list it says what the player does and how to bring music in; once there is
 * music (a NAS library, or songs picked here) it is the library, with the ways to add more under it.
 */
export function StartScreen({ snap, stocked, quietNotice, onShowSongs }: { snap: Snapshot; stocked: boolean; quietNotice: boolean; onShowSongs: () => void }) {
  const front = snap.page.kind === 'home' && !snap.libraryQuery.trim();
  return (
    <main className={stocked ? 'start stocked' : 'start'}>
      {!stocked && <HeroLine />}
      {!stocked && <p className="lede">Taiko plays your music and fills in each word of the lyrics as it is sung.</p>}
      {front && <Resume snap={snap} />}
      {stocked && <Library snap={snap} />}
      {front && <Ways snap={snap} stocked={stocked} quietNotice={quietNotice} onShowSongs={onShowSongs} />}
    </main>
  );
}

function Ways({ snap, stocked, quietNotice, onShowSongs }: { snap: Snapshot; stocked: boolean; quietNotice: boolean; onShowSongs: () => void }) {
  return (
    <>
      {stocked && <h2 className="ways-name">Add music</h2>}
      <div className="ways">
        <section className="way">
          <h2>Music on this device</h2>
          <p>Choose audio files, and their timed lyrics if you have them. They are read here and never uploaded.</p>
          <div className="actions">
            <button className="plain-button primary-button" type="button" onClick={async () => store.addFiles(await pickFiles())}>Choose files</button>
            {canPickFolder() && <button className="plain-button" type="button" onClick={async () => store.addFiles(await pickFiles(true), true)}>Choose a folder</button>}
            <span className="hint-text">or drop them anywhere on this page</span>
          </div>
          {snap.notice && !quietNotice && <p className="notice" role="status">{snap.notice}</p>}
          <dl className="formats">
            <dt>Audio</dt>
            <dd>FLAC, MP3, or any format this browser plays</dd>
            <dt>Lyrics</dt>
            <dd>Apple Music lyrics JSON, TTML or LRC, named like the song: Song.flac with Song.json. Versions of one song are combined.</dd>
          </dl>
        </section>
        <NasWay snap={snap} onShowSongs={onShowSongs} />
      </div>
      <p className="fine-print">A song's Apple Music ID, and what you search Apple Music for, go to Apple to name the song. Nothing else leaves this device.</p>
    </>
  );
}

/** Asks before pairing: an invite link can name any server, so the person sees which one first. */
export function PairDialog({ snap }: { snap: Snapshot }) {
  const [name, setName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const link = snap.pendingPair;
  if (!link) return null;
  return (
    <div className="scrim">
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="pair-title" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await store.confirmPair(name); setBusy(false); }}>
        <h2 id="pair-title">Pair with this NAS?</h2>
        <p>This pairs the device with <strong>{new URL(link.base).host}</strong>. Only continue if you trust whoever runs it.</p>
        <label>Name for this device<input type="text" value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={60} /></label>
        {snap.pairError && <p className="notice" role="alert">{snap.pairError}</p>}
        <div className="actions">
          <button className="plain-button primary-button" type="submit" disabled={busy}>{busy ? 'Pairing' : 'Pair'}</button>
          <button className="plain-button" type="button" onClick={() => store.cancelPair()}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
