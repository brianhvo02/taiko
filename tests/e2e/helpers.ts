import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NAS, SWEEP_BASE, SWEEP_RATE, catalog } from './fixtures.ts';

export interface PickedFile {
  name: string;
  content: Buffer | string;
}

/** Apple's catalog, answered from the fixtures: no test talks to Apple. */
export async function mockCatalog(page: Page): Promise<void> {
  await page.route('https://itunes.apple.com/**', (route) => {
    const url = new URL(route.request().url());
    const hit = catalog[url.searchParams.get('country') ?? ''];
    const body = JSON.stringify({ resultCount: hit ? 1 : 0, results: hit ? [hit] : [] });
    // The player falls back to a script request with a callback when a plain one fails; answer both.
    const callback = url.searchParams.get('callback');
    return route.fulfill(callback
      ? { contentType: 'text/javascript', body: `${callback}(${body})` }
      : { contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body });
  });
}

/** Picks files through the button named, as a person would through the system's file dialog. */
export async function pick(page: Page, button: string, files: PickedFile[]): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: button, exact: true }).first().click()]);
  await chooser.setFiles(files.map((file) => ({
    name: file.name,
    mimeType: file.name.endsWith('.flac') ? 'audio/flac' : 'application/octet-stream',
    buffer: typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content,
  })));
}

/** The position the player shows, in seconds. The dev build exposes its store for this. */
export const shown = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { taikoStore: { position(): number } }).taikoStore.position());

export const seekTo = (page: Page, seconds: number): Promise<void> =>
  page.evaluate((t) => (window as unknown as { taikoStore: { seek(t: number): void } }).taikoStore.seek(t), seconds);

/**
 * Starts listening to the player's audio. Call it before the song loads when the audio comes from another origin
 * (the NAS), so the element asks for it in a way that lets a page analyse it.
 */
export async function listen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { taikoStore: { audio: HTMLAudioElement; position(): number } }).taikoStore;
    store.audio.crossOrigin = 'anonymous';
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0;
    context.createMediaElementSource(store.audio).connect(analyser);
    analyser.connect(context.destination);
    const bins = new Float32Array(analyser.frequencyBinCount);
    (window as unknown as { hear: () => { frequency: number; level: number; window: number; shown: number } }).hear = () => {
      void context.resume();
      analyser.getFloatFrequencyData(bins);
      let peak = 2;
      for (let i = 3; i < bins.length - 1; i++) if (bins[i] > bins[peak]) peak = i;
      const [a, b, c] = [bins[peak - 1], bins[peak], bins[peak + 1]];
      const shift = (a - c) / (2 * (a - 2 * b + c));
      return { frequency: ((peak + shift) * context.sampleRate) / analyser.fftSize, level: b, window: analyser.fftSize / context.sampleRate, shown: store.position() };
    };
  });
}

/**
 * Checks that the audio is where the player says it is: the tone's pitch gives the time really playing. Tried a
 * few times, since a measurement taken while the stream is still starting hears nothing yet.
 */
export async function expectInTime(page: Page, label: string): Promise<void> {
  await expect(async () => {
    const heard = await page.evaluate(() => (window as unknown as { hear: () => { frequency: number; level: number; window: number; shown: number } }).hear());
    expect(heard.level, `${label}: the tone is audible`).toBeGreaterThan(-70);
    // The analysis looks back over its window, so what it hears is from about half a window ago.
    const really = (heard.frequency - SWEEP_BASE) / SWEEP_RATE + heard.window / 2;
    expect(Math.abs(really - heard.shown), `${label}: heard ${really.toFixed(2)} s, shown ${heard.shown.toFixed(2)} s`).toBeLessThan(0.35);
  }).toPass({ timeout: 10_000, intervals: [400] });
}

/** A pairing link from the test NAS, made the way its owner would. */
/** Runs one of the test NAS's own commands (`invite`, `user add Aki`), as its owner would, and gives what it printed. */
export function nasCommand(...args: string[]): string {
  return execFileSync(process.execPath, ['server/dist/server.mjs', ...args], {
    env: { ...process.env, PUBLIC_BASE: NAS.base, APP_URL: NAS.app, DATA_DIR: NAS.data },
    encoding: 'utf8',
  });
}

/** A pairing link: for one of the owner's devices, or for a device of the user named. */
export function invite(user = ''): string {
  const out = nasCommand('invite', ...(user ? ['--user', user] : []));
  const link = /http:\/\/localhost:\d+\/#pair=\S+/.exec(out);
  if (!link) throw new Error(`no pairing link in: ${out}`);
  return link[0];
}

/** Opens an invite link and pairs, leaving the player on its first screen, paired. */
/**
 * Empties the playlists the test NAS keeps for every paired device, so one test's playlists never show up in
 * another's. The server reads its file afresh on every request.
 */
export function clearSharedPlaylists(): void {
  rmSync(`${NAS.data}/playlists.json`, { force: true });
}

export async function pair(page: Page, deviceName = 'Test browser', user = ''): Promise<void> {
  await page.goto(invite(user));
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`localhost:${NAS.port}`);
  await dialog.getByRole('textbox').fill(deviceName);
  await dialog.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByText(`Paired with Test NAS as ${deviceName}.`)).toBeVisible();
}
