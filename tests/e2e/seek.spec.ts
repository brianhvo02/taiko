import { expect, test } from '@playwright/test';
import { toneFlac } from './fixtures.ts';
import { expectInTime, listen, pick, seekTo, shown } from './helpers.ts';

/**
 * Exact seeking (src/shared/flac.ts). The player never asks the browser to seek a FLAC file; it restarts the audio
 * from the frame at the time asked for. These tests hear where the audio really is, from the tone's pitch, and
 * compare it with the position shown, which is what the lyrics follow.
 */
test('the audio is where the player says it is after every kind of seek', async ({ page }) => {
  await page.goto('/');
  await listen(page);
  await pick(page, 'Choose files', [{ name: 'Tone.flac', content: toneFlac({ seconds: 50, title: 'Tone' }) }]);
  const play = page.locator('.play');
  await play.click();
  await expect(play).toHaveText('Pause');
  await expectInTime(page, 'from the start');

  for (const target of [30, 44.4, 7, 0, 21.7]) {
    await seekTo(page, target);
    await expect.poll(() => shown(page), { message: `the position moves to ${target}` }).toBeGreaterThanOrEqual(target - 0.25);
    expect(await shown(page)).toBeLessThan(target + 4);
    await expectInTime(page, `after seeking to ${target}`);
    await expect(play).toHaveText('Pause');
  }

  // Dragging the seek bar asks for many places in a row; only the last one counts.
  await page.evaluate(() => {
    const store = (window as unknown as { taikoStore: { seek(t: number): void } }).taikoStore;
    for (let t = 10; t <= 36; t += 2) store.seek(t);
  });
  await expect.poll(() => shown(page)).toBeGreaterThan(35.5);
  await expectInTime(page, 'after a drag ending at 36');

  await page.locator('.seek-row input').fill('15');
  await expect.poll(() => shown(page)).toBeGreaterThan(14.7);
  expect(await shown(page)).toBeLessThan(19);
  await expectInTime(page, 'after the seek bar');

  await page.locator('body').press('ArrowRight');
  await expectInTime(page, 'after the right arrow key');

  // A seek while paused stays paused, at the place asked for.
  await play.click();
  await expect(play).toHaveText('Play');
  await seekTo(page, 26);
  await expect.poll(() => shown(page)).toBeGreaterThan(25.7);
  await page.waitForTimeout(600);
  expect(await shown(page)).toBeLessThan(26.05);
  await expect(play).toHaveText('Play');
  await play.click();
  await expectInTime(page, 'resumed after a paused seek');
});

test('a song that ends can be played again from its start', async ({ page }) => {
  await page.goto('/');
  await listen(page);
  await pick(page, 'Choose files', [{ name: 'Tone.flac', content: toneFlac({ seconds: 50, title: 'Tone' }) }]);
  const play = page.locator('.play');
  await play.click();
  await expect(play).toHaveText('Pause');
  await seekTo(page, 48.5);
  await expect.poll(() => shown(page)).toBeGreaterThan(48.4);
  // It plays out its last second and a half and stops.
  await expect(play).toHaveText('Play', { timeout: 15_000 });
  expect(await shown(page)).toBeGreaterThan(49.5);

  await play.click();
  await expect(play).toHaveText('Pause');
  await expect.poll(() => shown(page)).toBeLessThan(5);
  await expectInTime(page, 'played again');
});
