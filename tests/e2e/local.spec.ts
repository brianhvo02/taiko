import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { lyrics, toneFlac } from './fixtures.ts';
import { mockCatalog, pick, shown } from './helpers.ts';

const lanterns = () => ({ name: 'Lanterns.flac', content: toneFlac({ seconds: 50, title: 'Tagged Lanterns', artist: 'Midori Vale', album: 'Night Market', track: 1 }) });
const harbour = () => ({ name: 'Harbour.flac', content: toneFlac({ seconds: 20, title: 'Harbour Lights', artist: 'Midori Vale', album: 'Night Market', track: 2 }) });
const versions = [
  { name: 'Lanterns.json', content: lyrics.plain },
  { name: 'Lanterns.ja-Latn.json', content: lyrics.roman },
  { name: 'Lanterns_en.json', content: lyrics.english },
];

test.beforeEach(async ({ page }) => {
  await mockCatalog(page);
  await page.goto('/');
});

test('plays a song with lyrics combined from three versions and named by the catalog', async ({ page }) => {
  await pick(page, 'Choose files', [lanterns(), ...versions]);

  const lines = page.locator('.lyrics .line');
  await expect(lines).toHaveCount(3);
  await expect(page.locator('.lyrics .roman')).toHaveCount(3);
  await expect(page.locator('.lyrics .translation')).toHaveCount(3);
  await expect(page.locator('.part-name')).toHaveText(['Verse', 'Chorus']);
  // The catalog's names, home storefront first, replace the file's tags.
  await expect(page.locator('.now-title')).toHaveText('紙の灯籠 (Paper Lanterns)');
  await expect(page.locator('.credit')).toHaveText('Midori Vale, written by Midori Vale');
  await expect(page).toHaveTitle('紙の灯籠 - Taiko');
  await expect(page.locator('.seek-row output').last()).toHaveText('0:50');

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(lines.first()).toHaveAttribute('data-state', 'active', { timeout: 10_000 });
  const fill = (line: number, word: number) => lines.nth(line).locator('.original .w').nth(word).evaluate((el: HTMLElement) => Number(el.style.getPropertyValue('--p')));
  await expect.poll(() => fill(0, 0)).toBeGreaterThan(0);
  // The romanization fills in step with the lyric above it.
  expect(await lines.first().locator('.roman .w').first().evaluate((el: HTMLElement) => Number(el.style.getPropertyValue('--p')))).toBeGreaterThan(0);

  // Choosing a line moves the song there.
  await lines.nth(2).click();
  await expect.poll(() => shown(page)).toBeGreaterThan(29.8);
  expect(await shown(page)).toBeLessThan(34);
  await expect(lines.nth(2)).toHaveAttribute('data-state', 'active');
  await expect(lines.first()).toHaveAttribute('data-state', 'past');
  expect(await fill(0, 1)).toBe(1);

  // The lyric options open from the bar and close on a click elsewhere.
  await page.getByRole('button', { name: 'Options' }).click();
  await page.getByLabel('Romanization').uncheck();
  await expect(page.locator('.lyrics .roman').first()).toBeHidden();
  await expect(page.locator('.lyrics .translation').first()).toBeVisible();
  await page.getByLabel('Translation').uncheck();
  await expect(page.locator('.lyrics .translation').first()).toBeHidden();

  await page.getByRole('button', { name: 'Later' }).click();
  await expect(page.getByText('0.05 s later')).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download lyrics' }).click()]);
  expect(download.suggestedFilename()).toBe('Midori Vale - 紙の灯籠 (combined lyrics).json');
  const saved = await readFile(await download.path(), 'utf8');
  expect(saved).toContain('ja-Latn');
  expect(saved).toContain('en-US');
});

test('lists the songs, walks them, and pairs lyrics with songs by name', async ({ page }) => {
  await pick(page, 'Choose files', [harbour(), lanterns(), { name: 'Lanterns.json', content: lyrics.plain }]);

  // In album order, with the tags' names; the first one opens.
  await page.getByRole('button', { name: 'Songs' }).first().click();
  const rows = page.locator('.songs .song');
  await expect(rows.locator('.song-title')).toHaveText(['Tagged Lanterns', 'Harbour Lights']);
  await expect(rows.locator('.song-lead')).toHaveText(['1', '2']);
  await expect(rows.first()).toContainText('Lyrics, 0:50');
  await expect(rows.nth(1)).toContainText('0:20');
  await expect(rows.first()).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.lyrics .line')).toHaveCount(3);

  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Harbour Lights' })).toBeVisible();
  await expect(page.getByText('This song has no lyrics yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();

  // An LRC file named like the open song becomes its lyrics.
  await pick(page, 'Add a lyrics file', [{ name: 'Harbour.lrc', content: lyrics.lrc }]);
  await expect(page.locator('.lyrics .line')).toHaveCount(3);
  await expect(page.locator('.lyrics .line').first()).toHaveText('Paper lanterns');

  // Lyrics with other words are not mixed into a song's lyrics.
  await rows.first().click();
  await expect(page.locator('.now-title')).toContainText('紙の灯籠');
  await pick(page, 'Add files', [{ name: 'Lanterns.other.json', content: lyrics.other }]);
  await expect(page.locator('.toast')).toContainText('Lanterns.other.json has different lyrics from Lanterns.json, so it was left out.');
  await expect(page.locator('.lyrics .line').first()).toContainText('紙の灯籠');
});

test('sets the volume, mutes, and remembers the volume', async ({ page }) => {
  const volume = () => page.evaluate(() => {
    const audio = (window as unknown as { taikoStore: { audio: HTMLAudioElement } }).taikoStore.audio;
    return { volume: audio.volume, muted: audio.muted };
  });
  await pick(page, 'Choose files', [lanterns()]);
  const slider = page.getByLabel('Volume');
  await expect(slider).toHaveValue('1');

  await slider.fill('0.3');
  expect((await volume()).volume).toBeCloseTo(0.3);
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  expect(await volume()).toMatchObject({ muted: true });
  await expect(slider).toHaveValue('0');
  await page.getByRole('button', { name: 'Unmute' }).click();
  expect(await volume()).toMatchObject({ muted: false });
  await expect(slider).toHaveValue('0.3');

  await page.reload();
  await pick(page, 'Choose files', [lanterns()]);
  await expect(page.getByLabel('Volume')).toHaveValue('0.3');
  expect((await volume()).volume).toBeCloseTo(0.3);
});

test('says so when a file is neither audio nor lyrics', async ({ page }) => {
  await pick(page, 'Choose files', [{ name: 'cover.jpg', content: 'not a song' }]);
  await expect(page.locator('.start .notice')).toHaveText('cover.jpg is not audio or lyrics, so it was left out.');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test('fits the screen and folds the extra controls behind Options', async ({ page }) => {
    await pick(page, 'Choose files', [lanterns(), ...versions]);
    await expect(page.locator('.lyrics .line')).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    // The lines under the lyric stay readable.
    expect(await page.locator('.lyrics .roman').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(15);

    await expect(page.getByLabel('Romanization')).toBeHidden();
    await page.getByRole('button', { name: 'Options' }).click();
    await expect(page.getByLabel('Romanization')).toBeVisible();
    // On a phone the volume slider sits with the options, not on the bar.
    await expect(page.getByLabel('Volume')).toHaveCount(2);
    await expect(page.getByLabel('Volume').first()).toBeVisible();
    await page.mouse.click(195, 300);
    await expect(page.getByLabel('Romanization')).toBeHidden();

    // The Songs panel covers the screen, and choosing a song closes it.
    await page.getByRole('button', { name: 'Songs' }).click();
    await expect(page.getByRole('complementary', { name: 'Songs' })).toBeVisible();
    await page.locator('.songs .song').first().click();
    await expect(page.getByRole('complementary', { name: 'Songs' })).toBeHidden();
  });
});
