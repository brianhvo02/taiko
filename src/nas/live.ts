/**
 * The player's live connection to the NAS (see server/src/live.ts): a stream the server sends events down, saying
 * which of the user's other devices have the player open and what each is playing, and carrying their commands.
 * It is read with `fetch`, because the browser's own EventSource can't send the pairing token, and is opened again
 * whenever it drops, a little later each time. A NAS without it is simply left alone.
 */
import type { LiveEvent, PlaybackState, RemoteCommand } from '../shared/api';
import type { Pairing } from './client';

/** Opens the connection and keeps it open. The function returned closes it for good. */
export function openLive(pairing: Pairing, onEvent: (event: LiveEvent) => void, onDown: () => void): () => void {
  const abort = new AbortController();
  let wait = 2000;
  const run = async (): Promise<void> => {
    while (!abort.signal.aborted) {
      try {
        const response = await fetch(`${pairing.base}events`, { headers: { Authorization: `Bearer ${pairing.token}` }, signal: abort.signal });
        // A server from before it had this, or a device no longer paired: nothing to wait for.
        if (response.status === 404 || response.status === 405 || response.status === 401) return;
        if (!response.ok || !response.body) throw new Error('events');
        wait = 2000;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          for (let cut = pending.indexOf('\n\n'); cut >= 0; cut = pending.indexOf('\n\n')) {
            const block = pending.slice(0, cut);
            pending = pending.slice(cut + 2);
            if (!block.startsWith('data: ')) continue;
            try {
              onEvent(JSON.parse(block.slice(6)) as LiveEvent);
            } catch {
              // A line that isn't an event is passed over.
            }
          }
        }
      } catch {
        if (abort.signal.aborted) return;
      }
      onDown();
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 30_000);
    }
  };
  void run();
  return () => abort.abort();
}

const post = (pairing: Pairing, path: string, body: unknown): Promise<Response> =>
  fetch(pairing.base + path, { method: 'POST', headers: { Authorization: `Bearer ${pairing.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Tells the NAS what this device is playing. Best effort: a word that doesn't get through is followed by the next. */
export function sendState(pairing: Pairing, state: Partial<PlaybackState>): void {
  void post(pairing, 'state', state).catch(() => {});
}

/** Asks another of the user's devices to do something. False when it isn't there any more. */
export async function sendCommand(pairing: Pairing, deviceId: string, command: RemoteCommand): Promise<boolean> {
  try {
    return (await post(pairing, `devices/${encodeURIComponent(deviceId)}/command`, command)).ok;
  } catch {
    return false;
  }
}
