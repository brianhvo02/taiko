import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { toneFlac } from './fixtures.ts';
import { expectInTime, listen, mockCatalog, pair, pick, seekTo, shown } from './helpers.ts';

/** Repeat and shuffle, playlists, and what the browser keeps between visits. */

const short = (n: number) => ({ name: `Song ${n}.flac`, content: toneFlac({ seconds: 6, title: `Song ${n}`, artist: 'Midori Vale', album: 'Short Songs', track: n }) });
const title = (page: Page) => page.locator('.now-title');
const play = (page: Page) => page.locator('.play');
const repeat = (page: Page) => page.getByRole('button', { name: /^Repeat: / });
const shuffle = (page: Page) => page.getByRole('button', { name: 'Shuffle' });
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true });

test('repeat off stops after the last song; repeat all comes round; repeat one plays the song again', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Choose files', [short(1), short(2), short(3)]);
  await expect(title(page)).toHaveText('Song 1');

  // Off: Next walks to the last song and stops there.
  await expect(repeat(page)).toHaveAccessibleName('Repeat: off');
  await next(page).click();
  await next(page).click();
  await expect(title(page)).toHaveText('Song 3');
  await expect(next(page)).toBeDisabled();
  await play(page).click();
  await expect(play(page)).toHaveText('Pause');
  await seekTo(page, 4.5);
  await expect(play(page)).toHaveText('Play', { timeout: 15_000 });
  await expect(title(page)).toHaveText('Song 3');

  // All: Next leads on from the last song, and the last song's end starts the first.
  await repeat(page).click();
  await expect(repeat(page)).toHaveAccessibleName('Repeat: all songs');
  await expect(repeat(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(next(page)).toBeEnabled();
  await play(page).click();
  await seekTo(page, 4.5);
  await expect(title(page)).toHaveText('Song 1', { timeout: 15_000 });
  await expect(play(page)).toHaveText('Pause');
  // Back from the first song, once at its start, goes round to the last.
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(title(page)).toHaveText('Song 3');

  // One: the song that ends starts again, and the buttons still step.
  await repeat(page).click();
  await expect(repeat(page)).toHaveAccessibleName('Repeat: this song');
  await seekTo(page, 4.5);
  await expect.poll(() => shown(page)).toBeGreaterThan(4.4);
  await expect.poll(() => shown(page), { timeout: 15_000 }).toBeLessThan(3);
  await expect(title(page)).toHaveText('Song 3');
  await expect(play(page)).toHaveText('Pause');
  await expect(next(page)).toBeDisabled();
});

test('shuffle plays every song once in another order, and keeps the open song when switched', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Choose files', [1, 2, 3, 4, 5, 6].map(short));
  await next(page).click();
  await next(page).click();
  await expect(title(page)).toHaveText('Song 3');

  await shuffle(page).click();
  await expect(shuffle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(title(page)).toHaveText('Song 3');
  // The open song is first; the other five follow, each once.
  const heard = ['Song 3'];
  for (let i = 0; i < 5; i++) {
    await next(page).click();
    await expect(title(page)).not.toHaveText(heard[heard.length - 1]);
    heard.push(await title(page).innerText());
  }
  expect([...heard].sort()).toEqual(['Song 1', 'Song 2', 'Song 3', 'Song 4', 'Song 5', 'Song 6']);
  await expect(next(page)).toBeDisabled();
  // Back retraces what really played.
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(title(page)).toHaveText(heard[4]);

  // Switched off, the list carries on from the open song in its own order.
  await shuffle(page).click();
  const open = Number((await title(page).innerText()).replace('Song ', ''));
  if (open < 6) {
    await next(page).click();
    await expect(title(page)).toHaveText(`Song ${open + 1}`);
  } else {
    await expect(next(page)).toBeDisabled();
  }
});

test('keeps repeat, shuffle, the lyric lines shown and the volume between visits', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Choose files', [short(1), short(2)]);
  await repeat(page).click();
  await repeat(page).click();
  await shuffle(page).click();
  await page.getByLabel('Volume').fill('0.4');
  // A song with line-timed lyrics, to reach the switch for sweeping them.
  const lined = [short(1), { name: 'Song 1.lrc', content: '[00:01.00]one\n[00:03.00]two\n' }];
  await pick(page, 'Add a lyrics file', [lined[1]]);
  await page.getByRole('button', { name: 'Options' }).click();
  await page.getByLabel('Sweep across each line').check();

  await page.reload();
  await pick(page, 'Choose files', [...lined, short(2)]);
  await page.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByLabel('Sweep across each line')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(repeat(page)).toHaveAccessibleName('Repeat: this song');
  await expect(shuffle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Volume')).toHaveValue('0.4');
});

test('playlists: make one from a song, add to it, reorder, play through, and find it again after a reload', async ({ page }) => {
  await mockCatalog(page);
  await pair(page, 'Playlist test');
  await page.getByRole('button', { name: 'Open from NAS' }).click();
  const panel = page.getByRole('complementary', { name: 'Songs' });
  await panel.locator('.song.folder').first().click();
  await panel.locator('.song.folder', { hasText: 'Midori Vale' }).click();
  await panel.locator('.song.folder', { hasText: 'Night Market' }).click();
  const songs = panel.locator('.song:not(.folder)');
  await expect(songs).toHaveCount(3);

  // A new playlist, named from a song's row.
  await panel.getByRole('button', { name: 'More for Paper Lanterns' }).click();
  await panel.getByLabel('Name for a new playlist').fill('  Evening   walk ');
  await panel.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Made Evening walk with 1 song.');

  // Another song into it; the same song twice is refused.
  await panel.getByRole('button', { name: 'More for 港の灯' }).click();
  await panel.getByRole('button', { name: 'Evening walk' }).click();
  await expect(page.getByRole('status')).toContainText('Added 1 song to Evening walk.');
  await panel.getByRole('button', { name: 'More for 港の灯' }).click();
  await panel.getByRole('button', { name: 'Evening walk' }).click();
  await expect(page.getByRole('status')).toContainText('That song is already in Evening walk.');

  // The whole folder: only the song it lacks is added.
  await panel.getByRole('button', { name: 'More for this folder' }).click();
  await panel.getByRole('button', { name: 'Evening walk' }).click();
  await expect(page.getByRole('status')).toContainText('Added 1 song to Evening walk.');

  await panel.getByRole('tab', { name: 'Playlists' }).click();
  await expect(panel.locator('.song.list')).toHaveText(['PlaylistEvening walk3 songs']);
  await panel.locator('.song.list').click();
  const rows = panel.locator('.song:not(.list)');
  await expect(rows.locator('.song-title')).toHaveText(['Paper Lanterns', '港の灯', 'untagged']);

  // Reorder and remove.
  await panel.getByRole('button', { name: 'More for Paper Lanterns' }).click();
  await panel.getByRole('button', { name: 'Move down' }).click();
  await expect(rows.locator('.song-title')).toHaveText(['港の灯', 'Paper Lanterns', 'untagged']);
  await panel.getByRole('button', { name: 'More for untagged' }).click();
  await panel.getByRole('button', { name: 'Remove from playlist' }).click();
  await expect(rows.locator('.song-title')).toHaveText(['港の灯', 'Paper Lanterns']);

  // Play it through: its order, not the folder's, and the songs come with their lyrics and covers.
  await panel.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('heading', { name: '港の灯' })).toBeVisible();
  await expect(rows.first()).toHaveAttribute('aria-current', 'true');
  await next(page).click();
  await expect(title(page)).toHaveText('紙の灯籠 (Paper Lanterns)');
  await expect(page.locator('.lyrics .line')).toHaveCount(3);
  await expect(page.locator('.bar .art')).toHaveAttribute('src', /\/api\/cover\?/);
  await expect(next(page)).toBeDisabled();

  // It is still there after a reload, and can be renamed and deleted.
  await page.goto('/');
  await page.getByRole('button', { name: 'Playlists' }).click();
  await expect(panel.locator('.song.list')).toContainText('Evening walk');
  await panel.locator('.song.list').click();
  await expect(rows.locator('.song-title')).toHaveText(['港の灯', 'Paper Lanterns']);
  await panel.getByRole('button', { name: 'Rename' }).click();
  await panel.getByLabel('Playlist name').fill('Night walk');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel.locator('.album-name')).toHaveText('Night walk');
  await panel.getByRole('button', { name: 'Delete', exact: true }).click();
  await panel.getByRole('button', { name: 'Delete playlist' }).click();
  await expect(panel.getByText('No playlists yet.')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Playlists' }).click();
  await expect(panel.getByText('No playlists yet.')).toBeVisible();
});

test('offers to continue where the listener left off, with the queue, the moment and the song\'s lyric timing', async ({ page }) => {
  await mockCatalog(page);
  await pair(page, 'Resume test');
  await page.goto('/nas/play/Music/Midori%20Vale/Night%20Market/2%20-%20lanterns.flac');
  await listen(page);
  await expect(page.locator('.lyrics .line')).toHaveCount(3);
  await play(page).click();
  await expect(play(page)).toHaveText('Pause');
  await seekTo(page, 20);
  await expectInTime(page, 'before leaving');
  // This song's lyrics are nudged; another song's are not.
  await page.getByRole('button', { name: 'Options' }).click();
  await page.getByRole('button', { name: 'Later' }).click();
  await page.getByRole('button', { name: 'Later' }).click();
  await expect(page.getByText('0.10 s later')).toBeVisible();
  await page.getByLabel('Romanization').uncheck();
  await play(page).click();
  await expect(play(page)).toHaveText('Play');
  const left = await shown(page);

  // A new visit to the first screen offers it back.
  await page.goto('/');
  await listen(page);
  const offer = page.locator('.resume');
  await expect(offer).toContainText('Paper Lanterns, Midori Vale, at 0:2');
  await expect(offer).toContainText('2 more songs in the queue');
  await offer.getByRole('button', { name: 'Continue' }).click();
  await expect(title(page)).toHaveText('紙の灯籠 (Paper Lanterns)');
  await expect(play(page)).toHaveText('Pause');
  await expect.poll(() => shown(page)).toBeGreaterThan(left - 0.3);
  expect(await shown(page)).toBeLessThan(left + 6);
  await expectInTime(page, 'after continuing');
  await expect(page).toHaveURL('/nas/play/Music/Midori%20Vale/Night%20Market/2%20-%20lanterns.flac');

  // The nudge and the hidden romanization came back with it; the queue did too.
  await page.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByText('0.10 s later')).toBeVisible();
  await expect(page.getByLabel('Romanization')).not.toBeChecked();
  await page.keyboard.press('Escape');
  await next(page).click();
  await expect(page.getByRole('heading', { name: '港の灯' })).toBeVisible();
  await page.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByText('Lyrics in sync')).toHaveCount(0); // no lyrics, so no timing control
});
