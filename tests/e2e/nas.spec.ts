import { expect, test } from '@playwright/test';
import { expectInTime, invite, listen, mockCatalog, pair, seekTo, shown } from './helpers.ts';

/** The NAS server (started by playwright.config.ts with the library from start-nas.ts), through the player. */

test('pairs from an invite link, browses the folders and plays a song with its lyrics', async ({ page }) => {
  await mockCatalog(page);
  await pair(page);
  await listen(page);

  await page.getByRole('button', { name: 'Open from NAS' }).click();
  const panel = page.getByRole('complementary', { name: 'Songs' });
  const folders = panel.locator('.song.folder .song-title');
  const songs = panel.locator('.song:not(.folder)');
  const crumbs = panel.getByRole('navigation', { name: 'Folder' });

  await expect(folders).toHaveText(['Music']);
  await folders.first().click();
  await expect(folders).toHaveText(['Empty', 'Midori Vale']);
  await folders.nth(1).click();
  await expect(folders).toHaveText(['Night Market']);
  await folders.first().click();
  await expect(crumbs).toHaveText('All folders / Music / Midori Vale / Night Market');
  // Each folder has its own address.
  await expect(page).toHaveURL('/nas/folders/Music/Midori%20Vale/Night%20Market');

  // In file-name order ("2" before "10"), named by their tags; a file without tags keeps its file name, and
  // files that aren't songs are not listed.
  await expect(songs.locator('.song-title')).toHaveText(['Paper Lanterns', 'Harbour Lights', 'untagged']);
  await expect(songs.locator('.song-lead')).toHaveText(['2', '10', '']);
  await expect(songs.first()).toContainText('Midori Vale, Night Market');
  await expect(songs.first()).toContainText('Lyrics, 0:50');
  await expect(songs.nth(1)).toContainText('0:20');

  await songs.first().click();
  const lines = page.locator('.lyrics .line');
  await expect(lines).toHaveCount(3);
  await expect(page.locator('.lyrics .roman')).toHaveCount(3);
  await expect(page.locator('.lyrics .translation')).toHaveCount(3);
  await expect(page.locator('.now-title')).toHaveText('紙の灯籠 (Paper Lanterns)');
  await expect(page.locator('.play')).toHaveText('Pause');
  await expect(page.locator('.seek-row output').last()).toHaveText('0:50');
  await expect(page).toHaveURL('/nas/play/Music/Midori%20Vale/Night%20Market/2%20-%20lanterns.flac');
  await expectInTime(page, 'streamed from the NAS');

  // A seek asks the server for audio that begins at that time.
  const fromAFrame = page.waitForRequest((request) => /\/audio\?.*[?&]at=\d+/.test(request.url()));
  await seekTo(page, 31);
  await fromAFrame;
  await expect.poll(() => shown(page)).toBeGreaterThan(30.7);
  await expectInTime(page, 'after seeking the stream to 31');
  await expect(lines.nth(2)).toHaveAttribute('data-state', 'active');
  await seekTo(page, 3);
  await expectInTime(page, 'after seeking the stream back to 3');

  // Next and Back walk the folder the song came from.
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Harbour Lights' })).toBeVisible();
  await expect(page).toHaveURL('/nas/play/Music/Midori%20Vale/Night%20Market/10%20-%20harbour.flac');
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.locator('.now-title')).toContainText('紙の灯籠');
  await expect(page).toHaveURL('/nas/play/Music/Midori%20Vale/Night%20Market/2%20-%20lanterns.flac');

  // The browser's back button returns to the folder the song was chosen from, and the song plays on.
  await page.goBack();
  await expect(page).toHaveURL('/nas/folders/Music/Midori%20Vale/Night%20Market');
  await expect(crumbs).toHaveText('All folders / Music / Midori Vale / Night Market');
  await expect(page.locator('.play')).toHaveText('Pause');
  await page.goBack();
  await expect(page).toHaveURL('/nas/folders/Music/Midori%20Vale');
  await expect(folders).toHaveText(['Night Market']);
  await page.goForward();
  await expect(folders).toHaveCount(0);
  await expect(songs).toHaveCount(3);

  await crumbs.getByRole('button', { name: 'Music' }).click();
  await folders.first().click();
  await expect(panel.getByText('This folder has no songs or folders.')).toBeVisible();
});

test('keeps the pairing and the folder across a reload, and forgets the NAS when asked', async ({ page }) => {
  await pair(page, 'Reload test');
  await page.getByRole('button', { name: 'Open from NAS' }).click();
  const panel = page.getByRole('complementary', { name: 'Songs' });
  await panel.locator('.song.folder').first().click();
  await panel.locator('.song.folder', { hasText: 'Midori Vale' }).click();
  await expect(panel.getByRole('navigation', { name: 'Folder' })).toHaveText('All folders / Music / Midori Vale');

  // A reload opens the same address: the folder that was showing.
  await page.reload();
  await expect(panel.getByRole('navigation', { name: 'Folder' })).toHaveText('All folders / Music / Midori Vale');
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText('Paired with Test NAS as Reload test.')).toBeVisible();
  // From the first screen, the panel reopens at the folder it showed last.
  await page.getByRole('button', { name: 'Open from NAS' }).click();
  await expect(page).toHaveURL('/nas/folders/Music/Midori%20Vale');
  await panel.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Forget this NAS' }).click();
  await expect(page.getByRole('button', { name: 'Pair', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('NAS address')).toBeVisible();
});

test('refuses a pairing code that was already used', async ({ page, browser }) => {
  const link = invite();
  await page.goto(link);
  await page.getByRole('dialog').getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByText(/^Paired with Test NAS as /)).toBeVisible();

  const context = await browser.newContext();
  const second = await context.newPage();
  await second.goto(link);
  await second.getByRole('dialog').getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(second.getByRole('alert')).toHaveText("That code didn't work. Ask the NAS owner for a new invite.");
  await context.close();
});

test('opens a link to a song, at the time it names, and a link to a folder', async ({ page }) => {
  await mockCatalog(page);
  await pair(page, 'Link test');

  await page.goto('/nas/play/Music/Midori%20Vale/Night%20Market/2%20-%20lanterns.flac?t=31');
  await listen(page);
  await expect(page.locator('.now-title')).toHaveText('紙の灯籠 (Paper Lanterns)');
  await expect(page.locator('.lyrics .line')).toHaveCount(3);
  // A page can't start sound by itself: the song waits, at the time the link names, for Play.
  const play = page.locator('.play');
  await expect(play).toHaveText('Play');
  await expect.poll(() => shown(page)).toBeGreaterThan(30.7);
  expect(await shown(page)).toBeLessThan(31.05);
  await play.click();
  await expectInTime(page, 'a link opened at 31 seconds');
  // Next walks the song's folder, as if it had been chosen there.
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Harbour Lights' })).toBeVisible();

  await page.goto('/nas/folders/Music/Midori%20Vale/Night%20Market');
  const panel = page.getByRole('complementary', { name: 'Songs' });
  await expect(panel.getByRole('navigation', { name: 'Folder' })).toHaveText('All folders / Music / Midori Vale / Night Market');
  await expect(panel.locator('.song:not(.folder)')).toHaveCount(3);
});

test('says so when a link names a folder or a song the NAS does not have', async ({ page }) => {
  await pair(page, 'Missing test');
  const panel = page.getByRole('complementary', { name: 'Songs' });

  await page.goto('/nas/folders/Music/No%20Such%20Folder');
  await expect(page.getByRole('status')).toContainText("The NAS doesn't have that folder any more.");
  await expect(panel.locator('.song.folder .song-title')).toHaveText(['Music']);
  await expect(page).toHaveURL('/nas/folders');

  // A song that is gone opens the folder it was in.
  await page.goto('/nas/play/Music/Midori%20Vale/Night%20Market/99%20-%20gone.flac');
  await expect(page.getByRole('status')).toContainText("The NAS doesn't have that song any more.");
  await expect(panel.getByRole('navigation', { name: 'Folder' })).toHaveText('All folders / Music / Midori Vale / Night Market');
  await expect(page).toHaveURL('/nas/folders/Music/Midori%20Vale/Night%20Market');
});

test('tells an unpaired device to ask for an invite when it opens a NAS link', async ({ page }) => {
  await page.goto('/nas/play/Music/Midori%20Vale/Night%20Market/2%20-%20lanterns.flac');
  await expect(page.getByRole('status')).toHaveText("This link is for a NAS this device isn't paired with. Ask its owner to send you an invite.");
  await expect(page).toHaveURL('/');
  await expect(page.getByLabel('NAS address')).toBeVisible();
});
