/**
 * Who may use the server: pairing codes, paired devices, and the signed tickets that let an `<audio>` element fetch
 * a track without a token.
 *
 * Codes and tokens are kept only as SHA-256 hashes, so reading `DATA_DIR` gives nobody a way in.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from './store';

/** No I, O, 0 or 1, which read alike. 32 letters, so a code holds 60 bits. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const DEFAULT_CODE_DAYS = 3;
export const TICKET_LIFETIME_SECONDS = 6 * 60 * 60;
export const MAX_DEVICE_NAME_LENGTH = 64;
/** `lastSeenAt` is rewritten at most this often, so most requests don't write the store. */
const LAST_SEEN_STEP_MS = 60_000;

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function equalHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

// ---- Pairing codes and tokens ----

export function generateCode(): string {
  const letters = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  return `${letters.slice(0, 4)}-${letters.slice(4, 8)}-${letters.slice(8)}`;
}

/** A typed code in its stored form (`XXXX-XXXX-XXXX`), or null when it can't be one. Case, spaces and dashes don't matter. */
export function normalizeCode(input: string): string | null {
  const letters = input.toUpperCase().replace(/[\s-]/g, '');
  if (letters.length !== 12 || [...letters].some((letter) => !CODE_ALPHABET.includes(letter))) return null;
  return `${letters.slice(0, 4)}-${letters.slice(4, 8)}-${letters.slice(8)}`;
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

// ---- The server secret and tickets ----

/** The 32 random bytes tickets are signed with, made on the first start. Never logged. */
export function loadOrCreateSecret(dataDir: string): Buffer {
  const file = path.join(dataDir, 'secret.key');
  mkdirSync(dataDir, { recursive: true });
  try {
    // `wx` fails when the file exists, so two starts at once can't each make their own.
    writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // File modes aren't supported everywhere (Windows, some NAS shares).
  }
  const secret = readFileSync(file);
  if (secret.length !== 32) {
    throw new Error(`${file} is damaged (expected 32 bytes). Delete it to make a new one; audio links already handed out stop working.`);
  }
  return secret;
}

export function signTicket(secret: Buffer, trackId: string, exp: number): string {
  return createHmac('sha256', secret).update(`${trackId}.${exp}`).digest('hex');
}

export type TicketCheck = 'ok' | 'bad' | 'expired';

/** `exp` and `sig` come straight from the query string. The signature is checked before the expiry. */
export function verifyTicket(secret: Buffer, trackId: string, exp: string, sig: string, nowSeconds: number): TicketCheck {
  if (!/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return 'bad';
  if (!equalHex(sig, signTicket(secret, trackId, Number(exp)))) return 'bad';
  return Number(exp) > nowSeconds ? 'ok' : 'expired';
}

// ---- The store of codes and devices ----

export interface Device {
  id: string;
  name: string;
  tokenHash: string;
  pairedAt: string;
  lastSeenAt: string;
}

interface StoredCode {
  hash: string;
  /** ISO time. */
  expiresAt: string;
}

interface PairingData {
  version: 1;
  codes: StoredCode[];
  devices: Device[];
}

/**
 * Pairing codes and paired devices, in `DATA_DIR/pairing.json`.
 *
 * Nothing is cached: every call reads the file, and every change is read, changed and written back (atomically) in
 * one synchronous step. That is how the `invite`, `devices` and `unpair` subcommands work while the server runs: the
 * server sees a new code or a removed device on its next request, with no file watching or signals to get wrong. The
 * file is a few kilobytes, so reading it per request costs nothing next to the request itself. Two processes changing
 * it within the same millisecond could lose one change; the server writes only on pairing, on forgetting a device and
 * once a minute per active device (`lastSeenAt`), so that isn't guarded against.
 */
export class PairingStore {
  private readonly file: string;

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(dataDir, 'pairing.json');
  }

  private read(): PairingData {
    const raw = readJsonFile(this.file) as Partial<PairingData> | undefined;
    return {
      version: 1,
      codes: Array.isArray(raw?.codes) ? raw.codes : [],
      devices: Array.isArray(raw?.devices) ? raw.devices : [],
    };
  }

  private write(data: PairingData): void {
    const now = this.now();
    data.codes = data.codes.filter((code) => Date.parse(code.expiresAt) > now);
    writeJsonAtomic(this.file, data);
  }

  /** Makes a one-use code. The code itself is returned once and never stored. */
  createCode(days: number = DEFAULT_CODE_DAYS): { code: string; expiresAt: string } {
    const code = generateCode();
    const expiresAt = new Date(this.now() + days * 24 * 60 * 60 * 1000).toISOString();
    const data = this.read();
    data.codes.push({ hash: sha256Hex(code), expiresAt });
    this.write(data);
    return { code, expiresAt };
  }

  /** Uses up a code and pairs a device, or gives null when the code is wrong, used or expired. */
  redeem(input: string, deviceName: string): { token: string; device: Device } | null {
    const code = normalizeCode(input);
    if (!code) return null;
    const hash = sha256Hex(code);
    const data = this.read();
    const now = this.now();
    let found = -1;
    // Every stored code is compared, so the time taken doesn't say which one matched.
    data.codes.forEach((stored, index) => {
      if (equalHex(stored.hash, hash) && Date.parse(stored.expiresAt) > now) found = index;
    });
    if (found < 0) return null;
    data.codes.splice(found, 1);
    const token = generateToken();
    const at = new Date(now).toISOString();
    const device: Device = { id: randomBytes(6).toString('hex'), name: deviceName, tokenHash: sha256Hex(token), pairedAt: at, lastSeenAt: at };
    data.devices.push(device);
    this.write(data);
    return { token, device };
  }

  /** The device a token belongs to, or null. */
  authenticate(token: string): Device | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = sha256Hex(token);
    const data = this.read();
    let device: Device | null = null;
    for (const candidate of data.devices) {
      if (equalHex(candidate.tokenHash, hash)) device = candidate;
    }
    if (!device) return null;
    const now = this.now();
    if (now - Date.parse(device.lastSeenAt) >= LAST_SEEN_STEP_MS) {
      device.lastSeenAt = new Date(now).toISOString();
      try {
        this.write(data);
      } catch {
        // A full or read-only disk shouldn't lock a paired device out; only "last seen" goes stale.
      }
    }
    return device;
  }

  listDevices(): Device[] {
    return this.read().devices;
  }

  /** Devices whose id is `idOrName`, or failing that whose name is (ignoring case). */
  findDevices(idOrName: string): Device[] {
    const devices = this.read().devices;
    const byId = devices.filter((device) => device.id === idOrName);
    if (byId.length) return byId;
    return devices.filter((device) => device.name.toLowerCase() === idOrName.toLowerCase());
  }

  removeDevice(id: string): boolean {
    const data = this.read();
    const kept = data.devices.filter((device) => device.id !== id);
    if (kept.length === data.devices.length) return false;
    data.devices = kept;
    this.write(data);
    return true;
  }
}

// ---- Rate limit ----

/** At most `max` attempts per key in any `windowMs`. Kept in memory; a restart forgets it. */
export class RateLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  /** Counts an attempt and says whether it is allowed. */
  allow(key: string, now: number): boolean {
    if (this.attempts.size > 10_000) this.prune(now);
    const recent = (this.attempts.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.max) {
      this.attempts.set(key, recent);
      return false;
    }
    recent.push(now);
    this.attempts.set(key, recent);
    return true;
  }

  private prune(now: number): void {
    for (const [key, times] of this.attempts) {
      if (times.every((at) => now - at >= this.windowMs)) this.attempts.delete(key);
    }
  }
}
