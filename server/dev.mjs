// `npm run server:dev`: runs the built server against fixtures/music with development settings.
// Arguments pass through, so `node server/dev.mjs invite` makes a pairing code for the dev server.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const bundle = path.join(repo, 'server', 'dist', 'server.mjs');
const music = path.join(repo, 'fixtures', 'music');

if (!existsSync(bundle)) {
  console.error('server/dist/server.mjs is missing. Build it first: npm run server:build');
  process.exit(1);
}
if (!existsSync(music)) {
  // Nothing is created here: the server never writes to a library, and neither does this script.
  console.error(
    `The dev library folder is missing: ${music}\n` +
      'Make it and put a few audio files in it (with .lrc, .ttml or .json lyrics beside them, named like the song):\n' +
      '  mkdir fixtures/music        (bash; in PowerShell: mkdir fixtures\\music)\n' +
      'Music you own can go in fixtures/local, which git ignores; copy or link songs from there.',
  );
  process.exit(1);
}

const child = spawn(process.execPath, [bundle, ...process.argv.slice(2)], {
  cwd: repo,
  stdio: 'inherit',
  env: {
    ...process.env,
    LIBRARY_ROOTS: `dev=${music}`,
    DATA_DIR: path.join(repo, '.cache', 'server-data'),
    PORT: '4193',
    PUBLIC_BASE: 'http://localhost:4193/api/',
    APP_URL: 'http://localhost:5173/',
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
