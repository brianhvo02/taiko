// Bundles the server into one file, server/dist/server.mjs, which needs only Node to run.
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// fileURLToPath, not URL.pathname: on Windows the latter gives "/C:/...".
const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));

await build({
  entryPoints: [here('src/main.ts')],
  outfile: here('dist/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  logLevel: 'info',
});
