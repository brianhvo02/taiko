import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { toneFlac } from './fixtures.ts';
import { clearSharedPlaylists, expectInTime, listen, mockCatalog, nasCommand, pair, pick, seekTo, shown } from './helpers.ts';

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
  await page.getByLabel('Volume', { exact: true }).fill('0.4');
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
  await expect(page.getByLabel('Volume', { exact: true })).toHaveValue('0.4');
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
  await expect(panel.getByText('No playlists yet.')).toContainText('Your playlists are kept on Test NAS, for all of your devices.');
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
  await expect(first.getByText('Your playlists are kept on Test NAS, for all of your devices.')).toBeVisible();
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

test('each person has their own playlists, shares the ones they choose, and adds their own devices', async ({ page, browser }) => {
  // The owner adds a friend on the NAS and pairs a device for each of them.
  const friendName = `Aki ${Date.now() % 100000}`;
  nasCommand('user', 'add', friendName);
  await pair(page, 'Owner laptop');
  await expect(page.getByText('You are listening as Owner.')).toBeVisible();
  const friend = await (await browser.newContext()).newPage();
  await pair(friend, 'Friend phone', friendName);
  await expect(friend.getByText(`You are listening as ${friendName}.`)).toBeVisible();

  type Store = { getSnapshot(): { album: { tracks: { title: string }[] } | null; playlists: { id: string; name: string; tracks: unknown[] }[]; sharedPlaylists: { name: string }[] }; createPlaylist(name: string, tracks: unknown[], show: boolean): void; syncPlaylists(): Promise<void>; loadShared(): Promise<void> };
  const sync = async (on: Page) => {
    await on.waitForTimeout(700);
    await on.evaluate(async () => { const store = (window as unknown as { taikoStore: Store }).taikoStore; await store.syncPlaylists(); await store.loadShared(); });
  };

  // The owner makes three playlists and says who else may use two of them.
  await page.goto('/album/Music/Midori%20Vale/Night%20Market');
  await expect(page.locator('.library .songlist .song')).toHaveCount(3);
  await page.evaluate(() => {
    const store = (window as unknown as { taikoStore: Store }).taikoStore;
    const tracks = store.getSnapshot().album!.tracks;
    store.createPlaylist('Just mine', tracks.slice(0, 1), false);
    store.createPlaylist('For the house', tracks.slice(0, 2), false);
    store.createPlaylist('Road trip', tracks.slice(0, 1), false);
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Playlists' }).click();
  const panel = page.getByRole('complementary', { name: 'Songs' });
  for (const [name, choice] of [['For the house', 'Everyone can play it'], ['Road trip', 'Everyone can change it']]) {
    await panel.locator('.song.list', { hasText: name }).click();
    await panel.getByLabel('Who can use it').selectOption({ label: choice });
    await panel.getByRole('button', { name: 'All playlists' }).click();
  }
  await expect(panel.locator('.song.list', { hasText: 'Road trip' })).toContainText('Everyone can change it');
  await sync(page);

  // The friend has no playlists of their own, and is shown the two, not the private one.
  await sync(friend);
  await friend.getByRole('button', { name: 'Playlists' }).click();
  const theirs = friend.getByRole('complementary', { name: 'Songs' });
  await expect(theirs.getByText('No playlists yet.')).toBeVisible();
  await expect(theirs.getByRole('heading', { name: 'From other people' })).toBeVisible();
  await expect(theirs.locator('.song.list .song-title')).toHaveText(['For the house', 'Road trip']);
  await expect(theirs.locator('.song.list', { hasText: 'Road trip' })).toContainText("Owner's, and yours to change");

  // A public playlist plays but can't be changed; a collaborative one takes a song from the friend.
  await theirs.locator('.song.list', { hasText: 'For the house' }).click();
  await expect(theirs.getByText("Owner's playlist. You can play it; only they can change it.")).toBeVisible();
  await theirs.getByRole('button', { name: /^More for / }).first().click();
  await expect(theirs.getByRole('button', { name: 'Play next' })).toBeVisible();
  await expect(theirs.getByRole('button', { name: 'Remove from playlist' })).toHaveCount(0);
  await friend.keyboard.press('Escape');
  await theirs.getByRole('button', { name: 'All playlists' }).click();
  await friend.goto('/album/Music/Midori%20Vale/Night%20Market');
  await friend.getByRole('button', { name: 'More for 港の灯' }).click();
  const menu = friend.getByRole('group', { name: 'More for 港の灯' });
  await expect(menu.locator('.menu-pick', { hasText: "Owner's" })).toHaveText(["Road tripOwner's"]);
  await expect(menu.getByRole('button', { name: 'Create' })).toBeDisabled();
  await menu.locator('.menu-pick', { hasText: 'Road trip' }).click();
  await expect(friend.getByRole('status')).toContainText('Added 1 song to Road trip.');
  // The owner's device takes the change up.
  await sync(page);
  await expect.poll(() => page.evaluate(() => (window as unknown as { taikoStore: Store }).taikoStore.getSnapshot().playlists.find((playlist) => playlist.name === 'Road trip')?.tracks.length)).toBe(2);

  // The friend adds a device of their own, with no help from the owner.
  await friend.goto('/');
  await friend.getByRole('button', { name: 'Add another device' }).click();
  const link = await friend.getByLabel('Invite link').inputValue();
  await friend.getByRole('button', { name: 'Done' }).click();
  const tablet = await (await browser.newContext()).newPage();
  await tablet.goto(link);
  await tablet.getByRole('dialog').getByRole('textbox').fill('Friend tablet');
  await tablet.getByRole('dialog').getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(tablet.getByText(`You are listening as ${friendName}.`)).toBeVisible();

  // Removing the friend unpairs their devices; what they could see was the owner's all along.
  expect(nasCommand('user', 'remove', friendName)).toContain('2 devices unpaired');
  await friend.reload();
  await expect(friend.getByText('This device is no longer paired with the NAS.')).toBeVisible();
  await friend.context().close();
  await tablet.context().close();
});

test('favourites and history: a heard song is counted, and what is marked is kept for the person', async ({ page }) => {
  await mockCatalog(page);
  await pair(page, 'Listening test');
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByText('Nothing played yet.')).toBeVisible();
  await page.getByRole('tab', { name: 'Favourites' }).click();
  await expect(page.getByText('No favourites yet.')).toBeVisible();

  // The five-second song, heard past its half: one play. The album is marked, and the song from the bar.
  await page.goto('/album/Music/Midori%20Vale/Night%20Market');
  await page.getByRole('button', { name: 'Add to favourites', exact: true }).click();
  await expect(page.getByRole('button', { name: 'In your favourites' })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.library .songlist .song', { hasText: 'untagged' }).click();
  await page.locator('.bar').getByRole('button', { name: 'Add to favourites' }).click();
  await expect(page.locator('.bar').getByRole('button', { name: 'Remove from favourites' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => (window as unknown as { taikoStore: { getSnapshot(): { history: { total: number } | null } } }).taikoStore.getSnapshot().history?.total), { timeout: 15_000 }).toBe(1);

  // Back in the library: played lately, counted on its album, and listed in the history.
  await page.goto('/');
  await page.getByRole('tab', { name: 'Albums' }).click();
  await expect(page.getByRole('region', { name: 'Recently played' }).locator('.tile-title')).toHaveText(['Night Market']);
  await page.getByRole('tab', { name: 'History' }).click();
  const history = page.locator('.library .noted');
  await expect(history.first().locator('.song')).toHaveText([/untagged.*1 play/]);
  await expect(history.nth(1).locator('.song-title')).toHaveText(['untagged']);
  await page.getByRole('tab', { name: 'Favourites' }).click();
  await expect(page.locator('.library .noted').first().locator('.tile-title')).toHaveText(['Night Market']);
  await expect(page.locator('.library .noted').nth(1).locator('.song-title')).toHaveText(['untagged']);
  // The shelf is remembered, and the favourites are the NAS's: a reload brings both back.
  await page.reload();
  await expect(page.locator('.library .noted').nth(1).locator('.song-title')).toHaveText(['untagged']);
  await page.locator('.library .noted').first().locator('.tile').click();
  await expect(page.locator('.library .songlist .song', { hasText: 'untagged' })).toContainText('1 play');

  // A favourite is taken away from a song's own menu.
  await page.getByRole('button', { name: 'More for untagged' }).click();
  await page.getByRole('group', { name: 'More for untagged' }).getByRole('button', { name: 'Remove from favourites' }).click();
  await page.goto('/');
  await expect(page.locator('.library .noted')).toHaveCount(1);
});

test('the queue: play next, add to the end, rearrange, remove, and find it as it was after a reload', async ({ page }) => {
  await mockCatalog(page);
  await pair(page, 'Queue test');
  type Store = { upcoming(): { title: string }[]; getSnapshot(): { currentTrack: { title: string } | null } };
  const next = () => page.evaluate(() => (window as unknown as { taikoStore: Store }).taikoStore.upcoming().map((track) => track.title));
  const menuOf = (title: string) => page.getByRole('button', { name: `More for ${title}` });

  // With nothing playing, "Play next" plays the song, alone.
  await page.goto('/album/Music/Midori%20Vale/Night%20Market');
  await menuOf('untagged').click();
  await page.getByRole('button', { name: 'Play next' }).click();
  await expect(page.locator('.now-title')).toHaveText('untagged');
  await page.locator('.play').click();
  await expect(page.locator('.play')).toHaveText('Play');
  expect(await next()).toEqual([]);

  // A song for the end, then one to go before it, then the first again: it moves to the end, not listed twice.
  await page.getByRole('button', { name: 'Library' }).first().click();
  await menuOf('Paper Lanterns').click();
  await page.getByRole('button', { name: 'Add to the queue' }).click();
  await expect(page.locator('.toast')).toContainText('Added Paper Lanterns to the queue.');
  await menuOf('港の灯').click();
  await page.getByRole('button', { name: 'Play next' }).click();
  await expect(page.locator('.toast')).toContainText('港の灯 will play next.');
  expect(await next()).toEqual(['港の灯', 'Paper Lanterns']);
  await menuOf('港の灯').click();
  await page.getByRole('button', { name: 'Add to the queue' }).click();
  await expect(page.locator('.toast')).toContainText('Moved 港の灯 to the end of the queue.');
  expect(await next()).toEqual(['Paper Lanterns', '港の灯']);

  // The Queue tab shows it, and each waiting song can be moved or taken out.
  await page.getByRole('button', { name: 'Songs' }).first().click();
  const panel = page.getByRole('complementary', { name: 'Songs' });
  await panel.getByRole('tab', { name: 'Queue' }).click();
  await expect(panel.locator('.song .song-title')).toHaveText(['untagged', 'Paper Lanterns', '港の灯']);
  await panel.getByRole('button', { name: 'More for 港の灯' }).click();
  await panel.getByRole('button', { name: 'Play next' }).click();
  await expect(panel.locator('.song .song-title')).toHaveText(['untagged', '港の灯', 'Paper Lanterns']);

  // It is the same after a reload, and Next follows it.
  await page.reload();
  await expect(page.locator('.now-title')).toHaveText('untagged');
  expect(await next()).toEqual(['港の灯', 'Paper Lanterns']);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { taikoStore: Store }).taikoStore.getSnapshot().currentTrack?.title)).toBe('港の灯');
  expect(await next()).toEqual(['Paper Lanterns']);
  await page.getByRole('button', { name: 'Songs' }).first().click();
  await panel.getByRole('tab', { name: 'Queue' }).click();
  await panel.getByRole('button', { name: 'More for Paper Lanterns' }).click();
  await panel.getByRole('button', { name: 'Remove from the queue' }).click();
  await expect(panel.getByText('Nothing after this')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
});

test('an album kept on the device plays with no connection to the NAS, lyrics and all', async ({ page }) => {
  await mockCatalog(page);
  await pair(page, 'Offline test');
  await page.goto('/album/Music/Midori%20Vale/Night%20Market');
  await expect(page.locator('.library .songlist .song')).toHaveCount(3);
  await page.getByRole('button', { name: 'Keep on this device' }).click();
  await expect(page.locator('.toast')).toContainText('Night Market is on this device, and plays with no connection.', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Remove from this device' })).toBeVisible();

  // The NAS goes out of reach: nothing it serves can be fetched.
  await page.route(/localhost:4195/, (route) => route.abort());
  await page.goto('/');
  await listen(page);
  await page.getByRole('button', { name: 'play what is on this device' }).click();
  await expect(page.getByRole('tab', { name: 'Downloaded' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.library .noted .tile-title')).toHaveText(['Night Market']);
  await expect(page.locator('.library-foot').first()).toContainText('of music is kept on this device');

  // The album opens from what was kept, and its songs play, in time, with their lyrics.
  await page.locator('.library .noted .tile').click();
  await expect(page.locator('.library .songlist .song .song-title')).toHaveText(['Paper Lanterns', '港の灯', 'untagged']);
  await page.locator('.library .songlist .song', { hasText: 'Paper Lanterns' }).click();
  await expect(page.locator('.lyrics .line')).toHaveCount(3);
  await expect(page.locator('.play')).toHaveText('Pause');
  await seekTo(page, 30);
  await expectInTime(page, 'from the kept copy, after a seek');
  await expect(page.locator('.lyrics .line').nth(2)).toHaveAttribute('data-state', 'active');

  // Taken off the device, it is gone from the list.
  await page.unroute(/localhost:4195/);
  await page.getByRole('button', { name: 'Library' }).first().click();
  await page.getByRole('button', { name: 'Remove from this device' }).click();
  await expect(page.getByRole('button', { name: 'Keep on this device' })).toBeVisible();
  await page.goto('/');
  await page.getByRole('tab', { name: 'Downloaded' }).click();
  await expect(page.getByText('Nothing is kept on this device yet.')).toBeVisible();
  // On a phone the library's tabs are wider than the screen; the row of tabs scrolls, not the page.
  await page.setViewportSize({ width: 390, height: 780 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
});

test('volume levelling: a song that says how loud it is plays at the common level, unless turned off', async ({ page }) => {
  await mockCatalog(page);
  await pair(page, 'Level test');
  const volume = () => page.evaluate(() => (window as unknown as { taikoStore: { audio: HTMLAudioElement } }).taikoStore.audio.volume);
  await page.goto('/album/Music/Midori%20Vale/Night%20Market');
  // From its album, in order: the album's level (16 dB down, less 4 dB of pre-amp: about a quarter).
  await page.locator('.library .songlist .song', { hasText: '港の灯' }).click();
  await expect(page.locator('.play')).toHaveText('Pause');
  await expect.poll(volume).toBeCloseTo(0.251, 2);
  // Shuffled, it is one song among others: its own level (10 dB down, less 4: about half).
  await page.getByRole('button', { name: 'Shuffle' }).click();
  await expect.poll(volume).toBeCloseTo(0.501, 2);
  // The listener's own volume is taken from there.
  await page.getByLabel('Volume', { exact: true }).fill('0.5');
  await expect.poll(volume).toBeCloseTo(0.251, 2);
  // Turned off, the song plays as it is; a song that doesn't say how loud it is always does.
  await page.getByRole('button', { name: 'Options' }).click();
  await page.getByLabel('Level the volume between songs').uncheck();
  await expect.poll(volume).toBeCloseTo(0.5, 2);
  await page.getByLabel('Level the volume between songs').check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Library' }).first().click();
  await page.locator('.library .songlist .song', { hasText: 'untagged' }).click();
  await expect.poll(volume).toBeCloseTo(0.5, 2);
  await page.getByRole('button', { name: 'Shuffle' }).click();
});

test('through the mixer: a song is levelled, heard, seeks and pauses, as on a phone that can\'t set the volume', async ({ page }) => {
  await mockCatalog(page);
  await pair(page, 'Mixer test');
  type Mixer = { context: AudioContext; gain: GainNode; speaker: HTMLAudioElement };
  type Store = { mixer: Mixer; setMixing(on: boolean): Promise<void>; audio: HTMLAudioElement; position(): number; getSnapshot(): { mixing: boolean } };
  const store = <T>(read: (store: Store) => T | Promise<T>) => page.evaluate(read as never) as Promise<T>;
  await page.goto('/album/Music/Midori%20Vale/Night%20Market');
  await page.locator('.library .songlist .song', { hasText: '港の灯' }).click();
  await expect(page.locator('.play')).toHaveText('Pause');

  // Turned on while a song plays, as the switch does on a phone: the song is loaded again and carries on.
  const before = await store(() => (window as unknown as { taikoStore: Store }).taikoStore.position());
  await store(async () => { await (window as unknown as { taikoStore: Store }).taikoStore.setMixing(true); });
  await expect(page.locator('.play')).toHaveText('Pause');
  await expect.poll(() => store(() => (window as unknown as { taikoStore: Store }).taikoStore.position())).toBeGreaterThan(before);

  // The song's sound comes out of the mixer's speaker, turned down to the album's level (see the levelling test).
  await store(() => {
    const { mixer } = (window as unknown as { taikoStore: Store }).taikoStore;
    const analyser = mixer.context.createAnalyser();
    analyser.fftSize = 2048;
    mixer.gain.connect(analyser);
    (window as unknown as { loudest: () => number }).loudest = () => {
      const bins = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(bins);
      return Math.max(...bins);
    };
  });
  await expect.poll(() => store(() => (window as unknown as { taikoStore: Store }).taikoStore.mixer.gain.gain.value)).toBeCloseTo(0.251, 2);
  await expect.poll(() => page.evaluate(() => (window as unknown as { loudest: () => number }).loudest())).toBeGreaterThan(-70);
  expect(await store(() => { const { mixer } = (window as unknown as { taikoStore: Store }).taikoStore; return [mixer.context.state, mixer.speaker.paused]; })).toEqual(['running', false]);

  // A seek goes quiet for the jump and comes back; a pause rests the speaker, and Play wakes it.
  await seekTo(page, 12);
  await expect.poll(() => shown(page)).toBeGreaterThan(12.2);
  await expect.poll(() => store(() => (window as unknown as { taikoStore: Store }).taikoStore.mixer.gain.gain.value)).toBeCloseTo(0.251, 2);
  await page.locator('.play').click();
  await expect(page.locator('.play')).toHaveText('Play');
  await expect.poll(() => store(() => (window as unknown as { taikoStore: Store }).taikoStore.mixer.speaker.paused), { timeout: 6000 }).toBe(true);
  await page.locator('.play').click();
  await expect.poll(() => store(() => (window as unknown as { taikoStore: Store }).taikoStore.mixer.speaker.paused)).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as unknown as { loudest: () => number }).loudest())).toBeGreaterThan(-70);

  // The next song comes through it too; and the choice is kept: a new visit starts with the mixer in place.
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect.poll(() => store(() => (window as unknown as { taikoStore: Store }).taikoStore.mixer.gain.gain.value)).toBeCloseTo(1, 2);
  await expect.poll(() => page.evaluate(() => (window as unknown as { loudest: () => number }).loudest())).toBeGreaterThan(-70);
  await page.reload();
  expect(await store(() => (window as unknown as { taikoStore: Store }).taikoStore.getSnapshot().mixing)).toBe(true);
  await store(async () => { await (window as unknown as { taikoStore: Store }).taikoStore.setMixing(false); });
});

test('crossfade: the next song rises as this one falls away, and an album in order is left alone', async ({ page }) => {
  await mockCatalog(page);
  await pair(page, 'Crossfade test');
  type Store = {
    decks: { elements: HTMLAudioElement[] }; audio: HTMLAudioElement; setCrossfade(seconds: number): void;
    getSnapshot(): { album: { tracks: { title: string }[] }; playlists: { id: string }[]; currentTrack: { title: string } | null };
    createPlaylist(name: string, tracks: unknown[], show: boolean): void; playPlaylist(id: string, index: number): Promise<void>;
  };
  const decks = () => page.evaluate(() => {
    const store = (window as unknown as { taikoStore: Store }).taikoStore;
    return { title: store.getSnapshot().currentTrack?.title, on: store.decks.elements.indexOf(store.audio), decks: store.decks.elements.map((element) => ({ playing: !element.paused, loaded: Boolean(element.getAttribute('src')), volume: element.volume })) };
  });
  await page.goto('/album/Music/Midori%20Vale/Night%20Market');
  await expect(page.locator('.library .songlist .song')).toHaveCount(3);

  // In a playlist, with two seconds of crossfade: near the end of the first song the second starts on the other
  // deck, both sound for a moment, and then the first is gone.
  await page.evaluate(async () => {
    const store = (window as unknown as { taikoStore: Store }).taikoStore;
    store.setCrossfade(2);
    store.createPlaylist('Fading', store.getSnapshot().album.tracks.filter((track) => track.title !== 'untagged'), false);
    await store.playPlaylist(store.getSnapshot().playlists[0].id, 0);
  });
  await expect(page.locator('.play')).toHaveText('Pause');
  expect((await decks()).on).toBe(0);
  await seekTo(page, 45);
  await expect.poll(async () => (await decks()).title, { timeout: 15_000 }).toBe('港の灯');
  await expect.poll(async () => { const now = await decks(); return now.on === 1 && now.decks[0].playing && now.decks[1].playing; }).toBe(true);
  const during = await decks();
  expect(during.decks[0].volume).toBeLessThan(1);
  await expect.poll(async () => { const now = await decks(); return [now.decks[0].playing, now.decks[0].loaded]; }, { timeout: 10_000 }).toEqual([false, false]);
  // The song that came in is at its full strength: its own level (it says it is loud, so about half; see the levelling test).
  await expect.poll(async () => (await decks()).decks[1].volume).toBeCloseTo(0.501, 2);
  await expect(page.locator('.play')).toHaveText('Pause');
  expect(await shown(page)).toBeGreaterThan(1);

  // The setting is under Options, and kept.
  await page.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByLabel('Crossfade')).toHaveValue('2');
  await page.keyboard.press('Escape');

  // The same album played in order: its songs follow each other, and the deck never changes.
  await page.getByRole('button', { name: 'Library' }).first().click();
  await page.locator('.library .songlist .song', { hasText: 'Paper Lanterns' }).click();
  // (The song has to be under way before the test jumps near its end.)
  await expect.poll(async () => (await decks()).title).toBe('Paper Lanterns');
  await expect.poll(() => shown(page)).toBeGreaterThan(0.3);
  const deck = (await decks()).on;
  await seekTo(page, 46);
  await expect.poll(async () => (await decks()).title, { timeout: 15_000 }).toBe('港の灯');
  expect((await decks()).on).toBe(deck);

  // Through the mixer, as on a phone: the same crossfade, done by the mixer's own fades.
  type Mixed = Store & { setMixing(on: boolean): Promise<void>; decks: Store['decks'] & { mixer: { fades: GainNode[] } } };
  const fades = () => page.evaluate(() => {
    const store = (window as unknown as { taikoStore: Mixed }).taikoStore;
    return { title: store.getSnapshot().currentTrack?.title, on: store.decks.elements.indexOf(store.audio), fades: store.decks.mixer.fades.map((fade) => fade.gain.value), playing: store.decks.elements.map((element) => !element.paused) };
  });
  await page.evaluate(async () => {
    const store = (window as unknown as { taikoStore: Mixed }).taikoStore;
    await store.setMixing(true);
    await store.playPlaylist(store.getSnapshot().playlists[0].id, 0);
  });
  await expect(page.locator('.play')).toHaveText('Pause');
  await expect.poll(async () => (await fades()).title).toBe('Paper Lanterns');
  await expect.poll(() => shown(page)).toBeGreaterThan(0.3);
  const from = (await fades()).on;
  await seekTo(page, 45);
  await expect.poll(async () => (await fades()).title, { timeout: 15_000 }).toBe('港の灯');
  await expect.poll(async () => { const now = await fades(); return now.on !== from && now.playing[0] && now.playing[1] && now.fades[from] < 1 && now.fades[now.on] > 0; }).toBe(true);
  await expect.poll(async () => { const now = await fades(); return [now.playing[from], now.fades[now.on], now.fades[from]]; }, { timeout: 10_000 }).toEqual([false, 1, 1]);
  await page.evaluate(async () => { await (window as unknown as { taikoStore: Mixed }).taikoStore.setMixing(false); });
});

test('gapless: the next song of an album begins on the very frame this one ends on', async ({ page, browserName }) => {
  // The test Firefox keeps a new audio context suspended until an audio element has sounded, so there the first
  // song falls back to an ordinary player (which is the engine's fallback working) and this test's steps don't hold.
  test.skip(browserName === 'firefox', 'headless Firefox holds a fresh AudioContext suspended');
  await mockCatalog(page);
  await pair(page, 'Gapless test');
  type Timeline = { rate: number; base: number; end: number; scheduled: number } | null;
  type Engine = { joined: boolean; timeline: Timeline; paused: boolean; levelNode: GainNode | null };
  type Store = {
    active: number; prepared: { id: string; deck: number } | null; decks: { engines: Engine[] };
    setGapless(on: boolean): void; position(): number; getSnapshot(): { currentTrack: { title: string } | null; playing: boolean };
  };
  const now = () => page.evaluate(() => {
    const store = (window as unknown as { taikoStore: Store }).taikoStore;
    return {
      title: store.getSnapshot().currentTrack?.title, deck: store.active, at: store.position(), prepared: store.prepared?.deck ?? null,
      engines: store.decks.engines.map((engine) => ({ joined: engine.joined, timeline: engine.timeline, paused: engine.paused })),
    };
  });
  await page.evaluate(() => (window as unknown as { taikoStore: Store }).taikoStore.setGapless(true));
  await page.goto('/album/Music/Midori%20Vale/Night%20Market');
  await page.locator('.library .songlist .song', { hasText: 'Paper Lanterns' }).click();
  await expect(page.locator('.play')).toHaveText('Pause');

  // A FLAC song plays on the engine (decks 2 and 3), and its time runs.
  await expect.poll(async () => (await now()).deck).toBe(2);
  await expect.poll(async () => (await now()).at).toBeGreaterThan(0.5);
  await expect(page.locator('.lyrics .line')).toHaveCount(3);

  // What comes out is listened to: both engine decks into one meter, read many times a second.
  await page.evaluate(() => {
    const store = (window as unknown as { taikoStore: Store }).taikoStore;
    const meters: AnalyserNode[] = [];
    const tap = () => {
      for (const [index, engine] of store.decks.engines.entries()) {
        const node = engine.levelNode as (GainNode & { tapped?: boolean }) | null;
        if (!node || node.tapped) continue;
        node.tapped = true;
        const meter = node.context.createAnalyser();
        meter.fftSize = 256;
        node.connect(meter);
        meters[index] = meter;
      }
    };
    const heard: number[] = [];
    (window as unknown as { heard: number[] }).heard = heard;
    const samples = new Float32Array(256);
    const listen = () => {
      tap();
      let loudest = 0;
      for (const meter of meters) {
        if (!meter) continue;
        meter.getFloatTimeDomainData(samples);
        for (const sample of samples) loudest = Math.max(loudest, Math.abs(sample));
      }
      heard.push(loudest);
      setTimeout(listen, 10);
    };
    listen();
  });

  // Near its end, the next song is got ready on the other engine deck, to begin where this one ends.
  await seekTo(page, 40);
  await expect.poll(async () => (await now()).at).toBeGreaterThan(40.2);
  await expect.poll(async () => (await now()).prepared, { timeout: 15_000 }).toBe(3);
  await expect.poll(async () => (await now()).engines[1].joined).toBe(true);
  const armed = await now();
  expect(armed.title).toBe('Paper Lanterns');
  expect(armed.engines[1].timeline!.base).toBe(armed.engines[0].timeline!.end);
  expect(armed.engines[1].timeline!.rate).toBe(armed.engines[0].timeline!.rate);
  const listenedFrom = await page.evaluate(() => (window as unknown as { heard: number[] }).heard.length);

  // The song changes at the join, with no load and no start: the other deck is simply the one being followed.
  await expect.poll(async () => (await now()).title, { timeout: 20_000 }).toBe('港の灯');
  const after = await now();
  expect(after.deck).toBe(3);
  expect(after.at).toBeLessThan(2);
  await expect(page.locator('.play')).toHaveText('Pause');
  await page.waitForTimeout(1500);
  // Across the join, sound never stopped.
  const heard = await page.evaluate((from) => (window as unknown as { heard: number[] }).heard.slice(from), listenedFrom);
  expect(heard.length).toBeGreaterThan(100);
  expect(Math.min(...heard)).toBeGreaterThan(0.02);

  // The song that came in seeks and pauses like any other, and the one after it is joined too.
  await seekTo(page, 14);
  await expect.poll(async () => (await now()).at).toBeGreaterThan(14.2);
  await expect.poll(async () => (await now()).prepared, { timeout: 15_000 }).toBe(2);
  await page.locator('.play').click();
  await expect(page.locator('.play')).toHaveText('Play');
  const paused = (await now()).at;
  await page.waitForTimeout(700);
  expect((await now()).at).toBeCloseTo(paused, 1);
  await page.locator('.play').click();
  await expect.poll(async () => (await now()).title, { timeout: 20_000 }).toBe('untagged');
  expect((await now()).deck).toBe(2);

  // Turned off, the open song goes back to an ordinary player and carries on.
  await page.evaluate(() => (window as unknown as { taikoStore: Store }).taikoStore.setGapless(false));
  await expect.poll(async () => (await now()).deck).toBeLessThan(2);
});

test('a join shaped in a playlist: leaves the first song early, fades, starts the next part-way in, and is kept', async ({ page }) => {
  await mockCatalog(page);
  await pair(page, 'Join test');
  type Store = {
    decks: { players: { paused: boolean }[] }; active: number; position(): number; syncPlaylists(): Promise<void>;
    getSnapshot(): { album: { tracks: { title: string }[] }; playlists: { id: string; transitions?: Record<string, unknown> }[]; currentTrack: { title: string } | null };
    createPlaylist(name: string, tracks: unknown[], show: boolean): void;
  };
  const now = () => page.evaluate(() => {
    const store = (window as unknown as { taikoStore: Store }).taikoStore;
    return { title: store.getSnapshot().currentTrack?.title, at: store.position(), deck: store.active, sounding: store.decks.players.filter((player) => !player.paused).length };
  });
  await page.goto('/album/Music/Midori%20Vale/Night%20Market');
  await expect(page.locator('.library .songlist .song')).toHaveCount(3);
  await page.evaluate(() => {
    const store = (window as unknown as { taikoStore: Store }).taikoStore;
    store.createPlaylist('Shaped', store.getSnapshot().album.tracks.filter((track) => track.title !== 'untagged'), true);
    (store as unknown as { openSongs(tab: string): void }).openSongs('playlists');
  });

  // The first song's menu opens the join with the next; the last song has no next to lead into.
  const panel = page.getByRole('complementary', { name: 'Songs' });
  await panel.getByRole('button', { name: 'More for 港の灯' }).click();
  await expect(panel.getByRole('button', { name: 'Shape how it leads into the next song' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: 'More for Paper Lanterns' }).click();
  await panel.getByRole('button', { name: 'Shape how it leads into the next song' }).click();
  const dialog = page.getByRole('dialog', { name: 'From Paper Lanterns into 港の灯' });
  await expect(dialog).toBeVisible();
  // As set under Options there is nothing to adjust; a crossfade can be.
  await expect(dialog.getByLabel('Leave Paper Lanterns')).toBeDisabled();
  await dialog.getByLabel('The join').selectOption('fade');
  await dialog.getByLabel('Crossfade for').fill('3');
  await dialog.getByLabel('Leave Paper Lanterns').fill('10');
  await dialog.getByLabel('Start 港の灯').fill('5');
  await expect(dialog.getByRole('img')).toHaveAccessibleName('A 3 second crossfade, leaving the first song 10 seconds early, starting the next 5 seconds in');

  // Heard before it is kept: it plays from a few seconds before the join (50 s, less 10, less 3, less 6).
  await dialog.getByRole('button', { name: 'Hear it' }).click();
  await expect.poll(async () => (await now()).at).toBeGreaterThan(31);
  expect((await now()).at).toBeLessThan(37);
  // The next song comes in ten seconds before the first would have ended, from five seconds in, both sounding.
  await expect.poll(async () => (await now()).title, { timeout: 15_000 }).toBe('港の灯');
  await expect.poll(async () => (await now()).sounding).toBe(2);
  await expect.poll(async () => (await now()).at).toBeGreaterThan(5);
  expect((await now()).at).toBeLessThan(9);
  await expect.poll(async () => (await now()).sounding, { timeout: 8000 }).toBe(1);

  // Kept, the row says so, and it is the NAS's too: a new visit has it.
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.locator('.song', { hasText: 'Paper Lanterns' })).toContainText('fades 3 s');
  await page.waitForTimeout(700);
  await page.evaluate(() => (window as unknown as { taikoStore: Store }).taikoStore.syncPlaylists());
  await page.goto('/');
  expect(await page.evaluate(() => Object.values((window as unknown as { taikoStore: Store }).taikoStore.getSnapshot().playlists[0].transitions ?? {}))).toEqual([{ kind: 'fade', seconds: 3, leave: 10, startAt: 5 }]);

  // Played in order from the playlist, the join is made the same way without being asked.
  await page.getByRole('button', { name: 'Playlists' }).click();
  await panel.locator('.song.list', { hasText: 'Shaped' }).click();
  await panel.locator('.song', { hasText: 'Paper Lanterns' }).first().click();
  await expect.poll(async () => (await now()).at).toBeGreaterThan(0.3);
  await seekTo(page, 33);
  await expect.poll(async () => (await now()).title, { timeout: 15_000 }).toBe('港の灯');
  await expect.poll(async () => (await now()).at).toBeGreaterThan(5);
  expect((await now()).at).toBeLessThan(9);

  // Put back to the usual, the shaping is gone.
  await panel.getByRole('button', { name: 'More for Paper Lanterns' }).click();
  await panel.getByRole('button', { name: 'Shape how it leads into the next song' }).click();
  await dialog.getByLabel('The join').selectOption('usual');
  await dialog.getByRole('button', { name: 'Put it back to the usual' }).click();
  await expect(panel.locator('.song', { hasText: 'Paper Lanterns' })).not.toContainText('fades');
});
