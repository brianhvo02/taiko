import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { toneFlac } from './fixtures.ts';
import { clearSharedPlaylists, expectInTime, listen, mockCatalog, pair, pick, seekTo, shown } from './helpers.ts';

test.beforeEach(() => clearSharedPlaylists());

/** Repeat and shuffle, playlists, and what the browser keeps between visits. */

const short = (n: number) => ({ name: `Song ${n}.flac`, content: toneFlac({ seconds: 6, title: `Song ${n}`, artist: 'Midori Vale', album: 'Short Songs', track: n }) });
// One pairing is handed from a test to a later one through a file, which outlives a restarted test worker.
const KEPT_PAIRING = '.cache/e2e/pairing.txt';
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
  await expect(page.locator('.bar .art')).toHaveAttribute('src', /\/api\/cover\?.*&size=small$/);
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
  // The NAS has been told too, so no other device is left with it.
  await expect(panel.getByText('No playlists yet.')).toContainText('Playlists are shared with every device paired with Test NAS.');
});

test('playlists are shared through the NAS: what one device makes, changes and deletes reaches another', async ({ page, browser }) => {
  await pair(page, 'First device');
  // A second browser with the same pairing: the NAS allows only so many pairings in ten minutes, and the playlists
  // are one set for the whole NAS whichever device asks.
  const pairing = await page.evaluate(() => localStorage.getItem('taiko:nas') ?? '');
  writeFileSync(KEPT_PAIRING, pairing);
  const other = await (await browser.newContext()).newPage();
  await other.addInitScript((saved) => localStorage.setItem('taiko:nas', saved), pairing);
  const open = async (on: Page) => {
    await on.goto('/');
    await on.getByRole('button', { name: 'Playlists' }).click();
    return on.getByRole('complementary', { name: 'Songs' });
  };

  const names = (on: Page) => on.evaluate(() => (window as unknown as { taikoStore: { getSnapshot(): { playlists: { name: string }[] } } }).taikoStore.getSnapshot().playlists.map((playlist) => playlist.name).sort());
  const sync = (on: Page) => on.evaluate(() => (window as unknown as { taikoStore: { syncPlaylists(): Promise<void> } }).taikoStore.syncPlaylists());

  // Made on the first device, it is on the second at its next visit.
  let first = await open(page);
  await first.getByLabel('Name for a new playlist').fill('Shared walk');
  await first.getByRole('button', { name: 'Create playlist' }).click();
  await first.getByRole('button', { name: 'All playlists' }).click().catch(() => undefined);
  await expect(first.getByText('Playlists are shared with every device paired with Test NAS.')).toBeVisible();
  // The change is sent a moment after it is made; the test waits for that instead of the moment.
  await page.waitForTimeout(700);
  await sync(page);
  let second = await open(other);
  await expect(second.locator('.song.list')).toContainText(['Shared walk']);

  // Renamed on the second, and one more made there while the first makes one of its own: all three end up on both.
  await second.locator('.song.list', { hasText: 'Shared walk' }).click();
  await second.getByRole('button', { name: 'Rename' }).click();
  await second.getByLabel('Playlist name').fill('Renamed walk');
  await second.getByRole('button', { name: 'Save' }).click();
  await page.evaluate(() => (window as unknown as { taikoStore: { createPlaylist(name: string): void } }).taikoStore.createPlaylist('From the first'));
  await other.evaluate(() => (window as unknown as { taikoStore: { createPlaylist(name: string): void } }).taikoStore.createPlaylist('From the second'));
  await expect.poll(async () => { await sync(page); await sync(other); return [await names(page), await names(other)]; })
    .toEqual([['From the first', 'From the second', 'Renamed walk'], ['From the first', 'From the second', 'Renamed walk']]);

  // Deleted on the first, they are gone from the second.
  for (const name of ['From the first', 'From the second', 'Renamed walk']) {
    await page.evaluate((wanted) => {
      const store = (window as unknown as { taikoStore: { getSnapshot(): { playlists: { id: string; name: string }[] }; deletePlaylist(id: string): void } }).taikoStore;
      store.deletePlaylist(store.getSnapshot().playlists.find((playlist) => playlist.name === wanted)!.id);
    }, name);
  }
  await expect.poll(async () => { await sync(page); await sync(other); return [await names(page), await names(other)]; }).toEqual([[], []]);
  first = await open(page);
  await expect(first.getByText('No playlists yet.')).toBeVisible();
  second = await open(other);
  await expect(second.getByText('No playlists yet.')).toBeVisible();
  await other.context().close();
});

test('comes back to where the listener left off, with the queue, the moment and the song\'s lyric timing', async ({ page }) => {
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

  // A new visit to the first screen has the song back in the bar, stopped at that moment and waiting for Play.
  await page.goto('/');
  await listen(page);
  await expect(title(page)).toHaveText('紙の灯籠 (Paper Lanterns)');
  await expect(play(page)).toHaveText('Play');
  await expect.poll(() => shown(page)).toBeGreaterThan(left - 0.3);
  expect(await shown(page)).toBeLessThan(left + 0.3);
  await expect(page).toHaveURL('/');
  await expect(page.locator('.lyrics')).toHaveCount(0);
  await play(page).click();
  await expect(play(page)).toHaveText('Pause');
  await expectInTime(page, 'after coming back');
  await play(page).click();
  await expect(play(page)).toHaveText('Play');
  const again = await shown(page);
  expect(again).toBeGreaterThan(left - 0.3);

  // Reloading the song's own page comes back to the moment too, with its lyrics showing.
  await page.getByRole('button', { name: 'Lyrics' }).click();
  await expect(page).toHaveURL('/nas/play/Music/Midori%20Vale/Night%20Market/2%20-%20lanterns.flac');
  await page.reload();
  await listen(page);
  await expect(page.locator('.lyrics .line')).toHaveCount(3);
  await expect.poll(() => shown(page)).toBeGreaterThan(again - 0.3);
  expect(await shown(page)).toBeLessThan(again + 0.3);
  await expect(play(page)).toHaveText('Play');
  // A link to a moment in the song is followed as written.
  await page.goto('/nas/play/Music/Midori%20Vale/Night%20Market/2%20-%20lanterns.flac?t=5');
  await expect.poll(() => shown(page)).toBeGreaterThan(4.7);
  expect(await shown(page)).toBeLessThan(5.3);
  await page.goto('/');
  await expect(title(page)).toHaveText('紙の灯籠 (Paper Lanterns)');

  // The nudge and the hidden romanization came back with it; the queue did too.
  await page.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByText('0.10 s later')).toBeVisible();
  await expect(page.getByLabel('Romanization')).not.toBeChecked();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Lyrics' }).click();
  await next(page).click();
  await expect(page.getByRole('heading', { name: '港の灯' })).toBeVisible();
  await page.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByText('Lyrics in sync')).toHaveCount(0); // no lyrics, so no timing control
});

test('a playlist and a link made before an album was replaced lead to the fresh copy', async ({ page }) => {
  await mockCatalog(page);
  // The pairing of the test before, when it ran: the NAS allows only so many pairings in ten minutes.
  const keptPairing = existsSync(KEPT_PAIRING) ? readFileSync(KEPT_PAIRING, 'utf8') : '';
  if (keptPairing) {
    await page.addInitScript((saved) => { if (!localStorage.getItem('taiko:nas')) localStorage.setItem('taiko:nas', saved); }, keptPairing);
    await page.goto('/');
  } else {
    await pair(page, 'Moved test');
  }
  // A playlist from an earlier visit, naming the song where it used to be.
  await page.evaluate(() => {
    const base = (JSON.parse(localStorage.getItem('taiko:nas') ?? '{}') as { base: string }).base;
    const bytes = new TextEncoder().encode('Music/Old Shelf/Night Market/02 lanterns.flac');
    const id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const old = { id, title: 'Lanterns (old copy)', artist: 'Midori Vale', album: 'Night Market', trackNumber: 2, discNumber: null, durationSeconds: 50 };
    localStorage.setItem('taiko:playlists', JSON.stringify({ [base]: [{ id: 'made-before', name: 'Made before', tracks: [old] }] }));
    localStorage.removeItem('taiko:playlist-sync');
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Playlists' }).click();
  const panel = page.getByRole('complementary', { name: 'Songs' });
  await panel.locator('.song.list', { hasText: 'Made before' }).click();
  // The song is listed as it is tagged now, and plays with its lyrics.
  const rows = panel.locator('.song:not(.list)');
  await expect(rows.locator('.song-title')).toHaveText(['Paper Lanterns']);
  await rows.first().click();
  await expect(page.locator('.lyrics .line')).toHaveCount(3);
  await expect(page).toHaveURL('/nas/play/Music/Midori%20Vale/Night%20Market/2%20-%20lanterns.flac');

  // A link to where the song used to be opens it where it is.
  await page.goto('/nas/play/Music/Old%20Shelf/Night%20Market/02%20lanterns.flac?t=20');
  await expect(title(page)).toHaveText('紙の灯籠 (Paper Lanterns)');
  await expect(page).toHaveURL(/\/nas\/play\/Music\/Midori%20Vale\/Night%20Market\/2%20-%20lanterns\.flac/);
  await expect.poll(() => shown(page)).toBeGreaterThan(19.5);
  // A song that is simply gone still says so.
  await page.goto('/nas/play/Music/Old%20Shelf/Night%20Market/09%20nothing.flac');
  await expect(page.getByText("The NAS doesn't have that song any more.")).toBeVisible();

  // The playlist is the NAS's now; it goes again so no other test finds it.
  await page.evaluate(() => (window as unknown as { taikoStore: { deletePlaylist(id: string): void } }).taikoStore.deletePlaylist('made-before'));
  await page.waitForTimeout(700);
  await page.evaluate(() => (window as unknown as { taikoStore: { syncPlaylists(): Promise<void> } }).taikoStore.syncPlaylists());
});

test('a song played to its end goes on to the next one once, not twice', async ({ page }) => {
  await mockCatalog(page);
  const keptPairing = existsSync(KEPT_PAIRING) ? readFileSync(KEPT_PAIRING, 'utf8') : '';
  if (keptPairing) {
    await page.addInitScript((saved) => { if (!localStorage.getItem('taiko:nas')) localStorage.setItem('taiko:nas', saved); }, keptPairing);
    await page.goto('/');
  } else {
    await pair(page, 'Ending test');
  }
  await page.goto('/album/Music/Midori%20Vale/Night%20Market');
  await expect(page.locator('.library .songlist .song')).toHaveCount(3);
  // Two songs from the NAS, on repeat, played whole with nothing sought: a browser that says both "paused at the
  // end" and "ended" used to move on twice, which in a list of two comes back to the song that just played.
  type Store = { getSnapshot(): { album: { tracks: { title: string }[] }; playlists: { id: string }[]; repeat: string; currentTrack: { title: string } | null }; createPlaylist(name: string, tracks: unknown[], show: boolean): void; cycleRepeat(): void; playPlaylist(id: string, index: number): Promise<void> };
  await page.evaluate(async () => {
    const store = (window as unknown as { taikoStore: Store }).taikoStore;
    store.createPlaylist('Two short songs', store.getSnapshot().album.tracks.filter((track) => track.title !== 'Paper Lanterns'), false);
    while (store.getSnapshot().repeat !== 'all') store.cycleRepeat();
    const tracks = store.getSnapshot().album.tracks.filter((track) => track.title !== 'Paper Lanterns');
    await store.playPlaylist(store.getSnapshot().playlists[0].id, tracks.findIndex((track) => track.title === 'untagged'));
  });
  const playing = () => page.evaluate(() => (window as unknown as { taikoStore: Store }).taikoStore.getSnapshot().currentTrack?.title);
  expect(await playing()).toBe('untagged');
  // The five-second song ends, and the other one is playing, and still is a moment later.
  await expect.poll(playing, { timeout: 15_000 }).toBe('港の灯');
  await page.waitForTimeout(2000);
  expect(await playing()).toBe('港の灯');
});
