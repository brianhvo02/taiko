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
import { PlaylistStore } from './playlists';
import { DEFAULT_CODE_DAYS, MAX_USER_NAME_LENGTH, PairingStore, loadOrCreateSecret } from './auth';
import type { User } from './auth';
import { loadConfig } from './config';
import { Library } from './library';
import { TagCache } from './tag-cache';
import { VERSION } from './version';

const USAGE = `Usage:
  server.mjs                     start the server
  server.mjs invite [--user <id|name>] [--days N]
                                 make a pairing code for one of that user's devices (the owner's unless
                                 --user says otherwise; valid ${DEFAULT_CODE_DAYS} days unless --days says otherwise)
  server.mjs devices             list paired devices and whose they are
  server.mjs unpair <id|name>    remove a paired device
  server.mjs users               list the users
  server.mjs user add <name>     add a user (family, a friend); then invite their device with --user
  server.mjs user rename <id|name> <new name>
  server.mjs user remove <id|name>
                                 remove a user and unpair their devices; the playlists they shared become the
                                 owner's, their private ones are deleted`;

class UsageError extends Error {}

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function serve(): void {
  const config = loadConfig(process.env);
  const secret = loadOrCreateSecret(config.dataDir);
  const pairing = new PairingStore(config.dataDir);
  pairing.listDevices(); // A damaged store stops the start, with a message, instead of failing every request.
  // One cache of tags for the scan and the folder browser, so opening a scanned album reads no file again.
  const tags = new TagCache();
  // Only the roots LIBRARY_SCAN names go into the library; every root stays reachable through the folder browser.
  const library = new Library(config.roots.filter((root) => config.scanRoots.includes(root.name)), tags, log);
  const server = createServer(createApp({ config, library, tags, pairing, playlists: new PlaylistStore(config.dataDir), secret, log }));

  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(error.code === 'EADDRINUSE' ? `taiko-server: port ${config.port} is already in use. Set PORT to a free one.` : `taiko-server: ${error.message}`);
    process.exit(1);
  });

  server.listen(config.port, () => {
    const roots = config.roots.map((root) => `${root.name}=${root.dir}`).join(', ');
    const started = `taiko-server ${VERSION} on port ${config.port}, serving ${config.publicBase}; roots: ${roots}`;
    if (!library.enabled) {
      // The folder browser reads a folder when asked, so nothing is scanned and `GET library` says it is off.
      log(`${started}; library off (LIBRARY_SCAN)`);
      return;
    }
    log(`${started}; library from: ${config.scanRoots.join(', ')}`);
    // Listening starts before the scan, so a paired device is told "scanning" rather than given no answer. The
    // library logs what each scan found ("library: N albums, M songs") when that differs from the scan before.
    library.scan();
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

/** The one user an id or a name picks out, or an error saying why it picks none or several. */
function pickUser(pairing: PairingStore, idOrName: string): User {
  const matches = pairing.findUsers(idOrName);
  if (matches.length === 1) return matches[0];
  throw new UsageError(matches.length ? `${matches.length} users match "${idOrName}". Use an id (see: users).` : `No user has the id or name "${idOrName}" (see: users).`);
}

function invite(args: string[]): void {
  let days = DEFAULT_CODE_DAYS;
  let who = '';
  const rest = [...args];
  while (rest.length) {
    const flag = rest.shift();
    const value = rest.shift();
    if (flag === '--days' && value !== undefined && Number(value) > 0 && Number(value) <= 365) days = Number(value);
    else if (flag === '--user' && value) who = value;
    else throw new UsageError('invite takes --user <id or name> and --days N, with N from 1 to 365.');
  }
  const config = loadConfig(process.env, { library: false });
  const pairing = new PairingStore(config.dataDir);
  const user = who ? pickUser(pairing, who) : pairing.listUsers().find((candidate) => candidate.owner)!;
  const { code, expiresAt } = pairing.createCode(days, user.id);
  console.log(`For a device of ${user.name}${user.owner ? ' (the owner)' : ''}.`);
  console.log(`Pairing code: ${code}`);
  console.log(`Pairing link: ${config.appUrls[0]}#pair=${encodeURIComponent(config.publicBase)}&code=${code}`);
  console.log(`Works once, until ${new Date(expiresAt).toLocaleString()}.`);
}

function table(rows: string[][]): void {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) console.log(row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd());
}

function users(): void {
  const config = loadConfig(process.env, { library: false });
  const pairing = new PairingStore(config.dataDir);
  const devices = pairing.listDevices();
  table([['ID', 'NAME', 'DEVICES', ''], ...pairing.listUsers().map((user) => [user.id, user.name, String(devices.filter((device) => device.userId === user.id).length), user.owner ? 'owner' : ''])]);
}

function user(args: string[]): void {
  const [action, ...rest] = args;
  const config = loadConfig(process.env, { library: false });
  const pairing = new PairingStore(config.dataDir);
  if (action === 'add' && rest.length) {
    const added = pairing.addUser(rest.join(' '));
    if (!added) throw new UsageError(`"${rest.join(' ')}" can't be added: the name is empty, longer than ${MAX_USER_NAME_LENGTH} characters, or already someone's (see: users).`);
    console.log(`Added ${added.name} (${added.id}). Invite their device with: invite --user ${added.id}`);
  } else if (action === 'rename' && rest.length >= 2) {
    const target = pickUser(pairing, rest[0]);
    const name = rest.slice(1).join(' ');
    if (!pairing.renameUser(target.id, name)) throw new UsageError(`${target.name} can't be renamed "${name}": the name is empty, longer than ${MAX_USER_NAME_LENGTH} characters, or already someone's.`);
    console.log(`${target.name} is now ${pairing.listUsers().find((candidate) => candidate.id === target.id)?.name}.`);
  } else if (action === 'remove' && rest.length === 1) {
    const target = pickUser(pairing, rest[0]);
    if (target.owner) throw new UsageError('The owner can\'t be removed. Rename them with: user rename');
    const passed = new PlaylistStore(config.dataDir).removeUser(target.id);
    const unpaired = pairing.removeUser(target.id) ?? 0;
    console.log(`Removed ${target.name}: ${unpaired} ${unpaired === 1 ? 'device' : 'devices'} unpaired, ${passed} shared ${passed === 1 ? 'playlist' : 'playlists'} passed to the owner. Audio links their devices already have stop working within 6 hours.`);
  } else {
    throw new UsageError('user takes: add <name>, rename <id or name> <new name>, or remove <id or name>.');
  }
}

function devices(): void {
  const config = loadConfig(process.env, { library: false });
  const pairing = new PairingStore(config.dataDir);
  const list = pairing.listDevices();
  if (!list.length) {
    console.log('No paired devices. Make a pairing code with: invite');
    return;
  }
  const date = (iso: string): string => new Date(iso).toLocaleString();
  table([['ID', 'NAME', 'USER', 'PAIRED', 'LAST SEEN'], ...list.map((device) => [device.id, device.name, pairing.userOf(device).name, date(device.pairedAt), date(device.lastSeenAt)])]);
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
  else if (command === 'users' && !args.length) users();
  else if (command === 'user') user(args);
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
