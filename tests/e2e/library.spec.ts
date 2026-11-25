import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { NAS, toneFlac } from './fixtures.ts';
import { mockCatalog, pair, pick } from './helpers.ts';

/** The library on the first screen: the NAS's albums and artists, its search, and this device's songs by album. */

const tiles = (page: import('@playwright/test').Page) => page.locator('.library .tile .tile-title');
const rows = (page: import('@playwright/test').Page) => page.locator('.library .songlist .song');
const albumUrl = '/album/Music/Midori%20Vale/Night%20Market';

// One pairing serves these tests: the NAS allows only so many pairings in ten minutes.
let pairing = '';
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await pair(page, 'Library test');
  pairing = await page.evaluate(() => localStorage.getItem('taiko:nas') ?? '');
  await page.close();
});
async function openPaired(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript((saved) => localStorage.setItem('taiko:nas', saved), pairing);
  await page.goto('/');
  await expect(page.getByText('Paired with Test NAS as Library test.')).toBeVisible();
}

test('lists the NAS albums, opens one at its own address and plays from it', async ({ page }) => {
  await mockCatalog(page);
  await openPaired(page);

  // By artist, as the NAS sends them. An album without a picture shows the first character of its name.
  await expect(tiles(page)).toHaveText(['Night Market', '引き潮']);
  await expect(page.locator('.library .tile .tile-detail')).toHaveText(['Midori Vale, 2026', 'Tin Harbor, 2024']);
  await expect(page.locator('.library .tile').nth(1).locator('.cover.blank')).toHaveText('引');
  await expect(page.locator('.library-foot')).toContainText('2 albums by 2 artists on Test NAS.');

  await page.getByLabel('Order of the albums').selectOption('year');
  await expect(tiles(page)).toHaveText(['Night Market', '引き潮']);
  await page.getByLabel('Order of the albums').selectOption('title');
  await expect(tiles(page)).toHaveText(['引き潮', 'Night Market']); // by its reading, Hikishio

  await tiles(page).filter({ hasText: 'Night Market' }).click();
  await expect(page).toHaveURL(albumUrl);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Night Market');
  await expect(page.locator('.sleeve-facts')).toHaveText('2026, 3 songs, 1 min');
  await expect(page.locator('.sleeve .cover')).toHaveJSProperty('complete', true);
  await expect(rows(page).locator('.song-title')).toHaveText(['Paper Lanterns', '港の灯', 'untagged']);
  // A song by someone other than the album's artist says so; a title in another script has its reading.
  await expect(rows(page).nth(1).locator('.song-detail')).toHaveText('Minato no Akari, Harbour Lights');

  // Choosing a song shows its lyrics; Library goes back to the album, and so does the browser's back button.
  await rows(page).first().click();
  await expect(page).toHaveURL('/nas/play/Music/Midori%20Vale/Night%20Market/2%20-%20lanterns.flac');
  await expect(page.locator('.lyrics .line')).toHaveCount(3);
  await expect(page.locator('.play')).toHaveText('Pause');
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Library' }).click();
  await expect(page).toHaveURL(albumUrl);
  await expect(rows(page).first()).toHaveAttribute('aria-current', 'true');
  await page.goBack();
  await expect(page.locator('.lyrics .line')).toHaveCount(3);
  await page.goBack();
  await expect(page).toHaveURL(albumUrl);

  // The next song comes on without leaving the library.
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(rows(page).nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(page).toHaveURL(albumUrl);

  // An album's address opens it again, and its artist leads to their albums.
  await page.reload();
  await expect(rows(page)).toHaveCount(3);
  await page.locator('.sleeve-artist').getByRole('button', { name: 'Midori Vale' }).click();
  await expect(page).toHaveURL('/artist/Midori%20Vale');
  await expect(tiles(page)).toHaveText(['Night Market']);
  await page.getByRole('button', { name: 'Library', exact: true }).first().click();
  await expect(page).toHaveURL('/');
  await page.getByRole('tab', { name: 'Artists' }).click();
  await expect(page.locator('.names .name-row-title')).toHaveText(['Midori Vale', 'Tin Harbor']);
});

test('searches albums, artists and songs by any of their names, and adds an album to a playlist', async ({ page }) => {
  await openPaired(page);
  const search = page.getByLabel('Search your library');

  await search.fill('hikishio');
  await expect(tiles(page)).toHaveText(['引き潮']);
  await search.fill('low tide');
  await expect(tiles(page)).toHaveText(['引き潮']);
  await search.fill('harbour lights');
  await expect(rows(page).locator('.song-title')).toHaveText(['港の灯']);
  await search.fill('zzzz');
  await expect(page.getByText('Nothing in your library matches.')).toBeVisible();

  await search.fill('lanterns');
  await rows(page).first().click();
  await expect(page.locator('.now-title')).toContainText('Paper Lanterns');
  await expect(page.locator('.lyrics .line')).toHaveCount(3);

  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Library' }).click();
  await search.fill('');
  await tiles(page).filter({ hasText: '引き潮' }).click();
  await expect(page.locator('.sleeve-other')).toHaveText('Hikishio, Low Tide');
  await page.getByRole('button', { name: 'More for this album' }).click();
  await page.getByLabel('Name for a new playlist').fill('Shore');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Shore' })).toContainText('Made Shore with 1 song.');
  await page.locator('.crumbs').getByRole('button', { name: 'Library' }).click();
  await page.getByRole('tab', { name: 'Playlists' }).click();
  await expect(page.locator('.names .name-row')).toContainText(['Shore']);
});

test('finds an album added to the NAS when asked to look for new music', async ({ page }) => {
  test.setTimeout(90_000);
  await openPaired(page);
  await expect(tiles(page)).toHaveCount(2);
  const added = path.join(NAS.library, 'Tin Harbor', 'Second Wind');
  try {
    mkdirSync(added, { recursive: true });
    writeFileSync(path.join(added, '1 - gust.flac'), toneFlac({ seconds: 4, title: 'Gust', artist: 'Tin Harbor', album: 'Second Wind', track: 1, tags: ['DATE=2025'] }));
    await page.getByRole('button', { name: 'Look for new music' }).click();
    await expect(tiles(page)).toHaveText(['Night Market', '引き潮', 'Second Wind']);
  } finally {
    rmSync(added, { recursive: true, force: true });
  }
  // The NAS takes one request to look again every ten seconds from a device. This one puts the library back.
  await page.waitForTimeout(10_500);
  await page.getByRole('button', { name: 'Look for new music' }).click();
  await expect(tiles(page)).toHaveText(['Night Market', '引き潮']);
});

test('groups the songs picked on this device by album', async ({ page }) => {
  const song = (n: number, album: string) => ({ name: `Song ${n}.flac`, content: toneFlac({ seconds: 5, title: `Song ${n}`, artist: 'Midori Vale', album, track: n }) });
  await page.goto('/');
  await pick(page, 'Choose files', [song(1, 'Short Songs'), song(2, 'Short Songs'), song(3, 'Long Nights')]);
  await expect(page).toHaveURL('/playing');
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Library' }).click();
  await expect(page.getByRole('heading', { name: 'On this device', exact: true })).toBeVisible();
  await expect(tiles(page)).toHaveText(['Long Nights', 'Short Songs']);
  await tiles(page).filter({ hasText: 'Short Songs' }).click();
  await expect(rows(page).locator('.song-title')).toHaveText(['Song 1', 'Song 2']);
  await rows(page).nth(1).click();
  await expect(page.locator('.now-title')).toHaveText('Song 2');
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
});

test('remembers which shelf was showing', async ({ page }) => {
  await openPaired(page);
  await page.getByRole('tab', { name: 'Artists' }).click();
  await expect(page.getByRole('tab', { name: 'Artists' })).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Artists' })).toHaveAttribute('aria-selected', 'true');
});
