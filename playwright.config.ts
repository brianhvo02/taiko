import { defineConfig, devices } from '@playwright/test';
import { NAS } from './tests/e2e/fixtures.ts';

/**
 * Browser tests (tests/e2e). They run against the dev server, whose build exposes the player's store to the page
 * so a test can read the true position, and against the built NAS server with a library of made-up songs.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  // One at a time: several tests listen to audio in real time, and the NAS tests share one server.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: NAS.app,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: { firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 } },
      },
    },
  ],
  webServer: [
    {
      command: `npm run dev -- --port ${NAS.webPort} --strictPort`,
      url: NAS.app,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run server:build && node tests/e2e/start-nas.ts',
      url: `${NAS.base}health`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
