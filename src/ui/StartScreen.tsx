import { useState } from 'react';
import { defaultDeviceName, normalizeBase } from '../nas/client';
import type { Snapshot } from '../player/store';
import { store } from '../player/store';
import { canPickFolder, pickFiles } from './format';

function NasSection({ snap, onShowSongs }: { snap: Snapshot; onShowSongs: () => void }) {
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState('');

  if (snap.pairing) {
    return (
      <section className="nas">
        <h2>Your NAS</h2>
        <p>Paired with {snap.pairing.serverName} as {snap.pairing.deviceName}.</p>
        <div className="actions">
          <button className="plain-button primary-button" type="button" onClick={onShowSongs}>Open from NAS</button>
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
    <section className="nas">
      <h2>Play from a NAS</h2>
      <p>If you or a friend run a Taiko server, open its invite link on this device, or enter its address and a pairing code.</p>
      <form className="pair-form" onSubmit={submit}>
        <label>NAS address<input type="url" value={address} onChange={(e) => setAddress(e.currentTarget.value)} placeholder="https://nas.example.com/taiko/api/" autoComplete="off" /></label>
        <label>Pairing code<input type="text" value={code} onChange={(e) => setCode(e.currentTarget.value)} placeholder="XXXX-XXXX-XXXX" autoComplete="off" autoCapitalize="characters" /></label>
        <button className="plain-button" type="submit">Pair</button>
      </form>
      {problem && <p className="notice" role="alert">{problem}</p>}
    </section>
  );
}

export function StartScreen({ snap, onShowSongs }: { snap: Snapshot; onShowSongs: () => void }) {
  return (
    <main className="start">
      <h1>Play your music with its lyrics in time</h1>
      <p>Choose audio files and, if you have them, their timed lyrics. They are read on this device and never uploaded. Only a song's Apple Music ID and what you type in the search are sent to Apple.</p>
      <ul className="slots">
        <li><span className="kind">Audio</span><span>FLAC, MP3, or any format this browser plays</span></li>
        <li><span className="kind">Lyrics</span><span>Apple Music lyrics JSON, TTML or LRC, named like the song (Song.flac with Song.json). Several versions of one song are combined.</span></li>
      </ul>
      <div className="actions">
        <button className="plain-button primary-button" type="button" onClick={async () => store.addFiles(await pickFiles())}>Choose files</button>
        {canPickFolder() && <button className="plain-button" type="button" onClick={async () => store.addFiles(await pickFiles(true), true)}>Choose a folder</button>}
        <span className="hint-text">or drop them anywhere on this page</span>
      </div>
      {snap.notice && <p className="notice" role="status">{snap.notice}</p>}
      <NasSection snap={snap} onShowSongs={onShowSongs} />
    </main>
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
