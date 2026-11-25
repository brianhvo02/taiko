import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { lyrics, toneFlac } from './fixtures.ts';
import { mockCatalog, pick, seekTo, shown } from './helpers.ts';

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
  // These lyrics time each word, so there is nothing to say about their timing, and nothing to switch.
  await expect(page.getByText('These lyrics are timed by line, not by word')).toHaveCount(0);
  await page.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByLabel('Romanization')).toBeVisible();
  await expect(page.getByLabel('Sweep across each line')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // The catalog's names, home storefront first, replace the file's tags.
  await expect(page.locator('.now-title')).toHaveText('紙の灯籠 (Paper Lanterns)');
  await expect(page.locator('.credit')).toHaveText('Midori Vale, written by Midori Vale');
  // How the file's audio is stored, read from the file.
  await expect(page.locator('.bar .quality')).toHaveText('16-bit 22.05 kHz');
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
  // A plain LRC file only times its lines: the player says so, and a line lights up whole, not word by word.
  await expect(page.getByText('These lyrics are timed by line, not by word')).toBeVisible();
  const fill = () => page.locator('.lyrics .line').first().locator('.w').first().evaluate((el: HTMLElement) => Number(el.style.getPropertyValue('--p') || 0));
  await seekTo(page, 1.5);
  await expect.poll(() => shown(page)).toBeGreaterThan(1.3);
  expect(await fill()).toBe(0);
  await seekTo(page, 2.5);
  await expect.poll(fill).toBe(1);
  // The listener can ask for such lines to be swept across anyway; the choice is kept.
  await page.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByLabel('Sweep across each line')).not.toBeChecked();
  await page.getByLabel('Sweep across each line').check();
  await seekTo(page, 3.5);
  await expect.poll(fill).toBeGreaterThan(0.2);
  expect(await fill()).toBeLessThan(0.9);
  await page.keyboard.press('Escape');

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
  const slider = page.getByLabel('Volume', { exact: true });
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
  await expect(page.getByLabel('Volume', { exact: true })).toHaveValue('0.3');
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
    await expect(page.getByLabel('Volume', { exact: true })).toHaveCount(2);
    await expect(page.getByLabel('Volume', { exact: true }).first()).toBeVisible();
    await page.mouse.click(195, 80);
    await expect(page.getByLabel('Romanization')).toBeHidden();

    // The Songs panel covers the screen, and choosing a song closes it.
    await page.getByRole('button', { name: 'Songs' }).click();
    await expect(page.getByRole('complementary', { name: 'Songs' })).toBeVisible();
    await page.locator('.songs .song').first().click();
    await expect(page.getByRole('complementary', { name: 'Songs' })).toBeHidden();
  });
});

test('keeps the line being sung at the top on a phone and in the middle on a wide screen', async ({ page }) => {
  await pick(page, 'Choose files', [lanterns(), ...versions]);
  const lines = page.locator('.lyrics .line');
  await expect(lines).toHaveCount(3);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  // Where the middle of the last line sits, as a share of the window's height, once the song is there.
  const place = async () => {
    await seekTo(page, 31);
    await expect(lines.nth(2)).toHaveAttribute('data-state', 'active');
    let last = -1;
    await expect.poll(async () => {
      const before = last;
      last = await lines.nth(2).evaluate((el) => { const box = el.getBoundingClientRect(); return (box.top + box.height / 2) / innerHeight; });
      return Math.abs(last - before);
    }).toBeLessThan(0.001);
    return last;
  };
  const wide = await place();
  expect(wide).toBeGreaterThan(0.4);
  expect(wide).toBeLessThan(0.6);

  await page.setViewportSize({ width: 390, height: 780 });
  await seekTo(page, 3);
  await expect(lines.first()).toHaveAttribute('data-state', 'active');
  const narrow = await place();
  expect(narrow).toBeLessThan(0.3);
  // Below the top strip, not under it.
  expect(await lines.nth(2).evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThan(56);
});

test('pressing a line moves the song there unless the listener turns that off', async ({ page }) => {
  await pick(page, 'Choose files', [lanterns(), ...versions]);
  const lines = page.locator('.lyrics .line');
  await expect(lines).toHaveCount(3);
  await page.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByLabel('Press a line to go to it')).toBeChecked();
  await page.getByLabel('Press a line to go to it').uncheck();
  await page.keyboard.press('Escape');

  // The line says it can't be pressed, so the test has to insist, as a stray touch would.
  await expect(lines.nth(2)).toHaveAttribute('aria-disabled', 'true');
  await lines.nth(2).click({ force: true });
  await page.waitForTimeout(500);
  expect(await shown(page)).toBeLessThan(5);

  // The choice is kept between visits, and can be taken back.
  await page.reload();
  await pick(page, 'Choose files', [lanterns(), ...versions]);
  await page.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByLabel('Press a line to go to it')).not.toBeChecked();
  await page.getByLabel('Press a line to go to it').check();
  await page.keyboard.press('Escape');
  await lines.nth(2).click();
  await expect.poll(() => shown(page)).toBeGreaterThan(29.8);
});

test('keeps the songs picked here for the next visit, with their lyrics, until they are forgotten', async ({ page }) => {
  // The lyrics file is named for no song, so it goes to the one that is open.
  await pick(page, 'Choose files', [harbour()]);
  await expect(page.locator('.now-title')).toHaveText('Harbour Lights');
  await pick(page, 'Add a lyrics file', [{ name: 'words.lrc', content: lyrics.lrc }]);
  await expect(page.locator('.lyrics .line')).toHaveCount(3);
  await page.getByRole('button', { name: 'Options' }).click();
  await pick(page, 'Add lyrics or music', [lanterns(), ...versions]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Songs' }).first().click();
  await expect(page.locator('.songs .song')).toHaveCount(2);

  await page.reload();
  // Nothing is open, but the songs are in the library, and play with the lyrics they had.
  await expect(page.locator('.now-title')).toHaveCount(0);
  await page.locator('.library .tile').filter({ hasText: 'Night Market' }).click();
  const rows = page.locator('.library .songlist .song');
  await expect(rows.locator('.song-title')).toHaveText(['Tagged Lanterns', 'Harbour Lights']);
  await rows.nth(1).click();
  await expect(page.locator('.lyrics .line')).toHaveCount(3);
  await expect(page.locator('.lyrics .line').first()).toHaveText('Paper lanterns');
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.locator('.lyrics .roman')).toHaveCount(3);

  // Forgetting them empties the list, now and on the next visit.
  await page.getByRole('button', { name: 'Songs' }).first().click();
  await page.getByRole('button', { name: 'Forget these songs' }).click();
  await page.getByRole('button', { name: 'Forget them' }).click();
  await expect(page.locator('.now-title')).toHaveCount(0);
  await expect(page.getByText('Music on this device')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Music on this device')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Songs' })).toHaveCount(0);
});
