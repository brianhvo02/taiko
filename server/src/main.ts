/**
 * The entry point.
 *
 *   node server.mjs                     start the server
 *   node server.mjs invite [--days N]   make a pairing code and print its link
 *   node server.mjs devices             list paired devices
 *   node server.mjs unpair <id|name>    remove a paired device
 *
 * The subcommands change `DATA_DIR/pairing.json` directly; the running server reads that file on every request (see
 * `PairingStore`), so they take effect at once and need no restart.
 */
import { createServer } from 'node:http';
import { createApp } from './app';
import { DEFAULT_CODE_DAYS, PairingStore, loadOrCreateSecret } from './auth';
import { loadConfig } from './config';
import { Library } from './library';
import { VERSION } from './version';

const USAGE = `Usage:
  server.mjs                     start the server
  server.mjs invite [--days N]   make a pairing code (valid ${DEFAULT_CODE_DAYS} days unless --days says otherwise)
  server.mjs devices             list paired devices
  server.mjs unpair <id|name>    remove a paired device`;

class UsageError extends Error {}

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function serve(): void {
  const config = loadConfig(process.env);
  const secret = loadOrCreateSecret(config.dataDir);
  const pairing = new PairingStore(config.dataDir);
  pairing.listDevices(); // A damaged store stops the start, with a message, instead of failing every request.
  const library = new Library(config.roots, log);
  const server = createServer(createApp({ config, library, pairing, secret, log }));

  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(error.code === 'EADDRINUSE' ? `taiko-server: port ${config.port} is already in use. Set PORT to a free one.` : `taiko-server: ${error.message}`);
    process.exit(1);
  });

  server.listen(config.port, () => {
    const roots = config.roots.map((root) => `${root.name}=${root.dir}`).join(', ');
    const started = `taiko-server ${VERSION} on port ${config.port}, serving ${config.publicBase}; roots: ${roots}`;
    if (!config.libraryScan) {
      // The folder browser reads a folder when asked, so nothing is scanned and `GET library` stays empty.
      log(`${started}; library scan off (LIBRARY_SCAN)`);
      return;
    }
    // Listening starts before the scan, so a paired device gets "still scanning" (scannedAt null) rather than no answer.
    library.scan().then(
      () => log(`${started}; library scan on, ${library.tracks.length} tracks`),
      (error) => log(`library: the first scan failed: ${String(error)}`),
    );
    library.startRescans(config.scanIntervalMinutes);
  });

  const stop = (): void => {
    library.stopRescans();
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function invite(args: string[]): void {
  let days = DEFAULT_CODE_DAYS;
  if (args.length) {
    days = Number(args[1]);
    if (args[0] !== '--days' || args.length !== 2 || !(days > 0 && days <= 365)) {
      throw new UsageError('invite takes only --days N, with N from 1 to 365.');
    }
  }
  const config = loadConfig(process.env, { library: false });
  const { code, expiresAt } = new PairingStore(config.dataDir).createCode(days);
  console.log(`Pairing code: ${code}`);
  console.log(`Pairing link: ${config.appUrls[0]}#pair=${encodeURIComponent(config.publicBase)}&code=${code}`);
  console.log(`Works once, until ${new Date(expiresAt).toLocaleString()}.`);
}

function devices(): void {
  const config = loadConfig(process.env, { library: false });
  const list = new PairingStore(config.dataDir).listDevices();
  if (!list.length) {
    console.log('No paired devices. Make a pairing code with: invite');
    return;
  }
  const date = (iso: string): string => new Date(iso).toLocaleString();
  const rows = [['ID', 'NAME', 'PAIRED', 'LAST SEEN'], ...list.map((device) => [device.id, device.name, date(device.pairedAt), date(device.lastSeenAt)])];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) console.log(row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd());
}

function unpair(args: string[]): void {
  if (args.length !== 1 || !args[0]) throw new UsageError('unpair takes one device id or name (see: devices).');
  const config = loadConfig(process.env, { library: false });
  const pairing = new PairingStore(config.dataDir);
  const matches = pairing.findDevices(args[0]);
  if (!matches.length) {
    console.error(`No paired device has the id or name "${args[0]}" (see: devices).`);
    process.exitCode = 1;
    return;
  }
  if (matches.length > 1) {
    console.error(`${matches.length} devices are named "${args[0]}". Unpair one by its id: ${matches.map((device) => device.id).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  pairing.removeDevice(matches[0].id);
  console.log(`Unpaired "${matches[0].name}" (${matches[0].id}). Audio links it already has stop working within 6 hours.`);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined) serve();
  else if (command === 'invite') invite(args);
  else if (command === 'devices' && !args.length) devices();
  else if (command === 'unpair') unpair(args);
  else if (command === 'help' || command === '--help' || command === '-h') console.log(USAGE);
  else throw new UsageError(`Unknown command "${[command, ...args].join(' ')}".`);
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  // A ConfigError's message already says what to set; other errors (a damaged store) say what is wrong.
  console.error(`taiko-server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
