import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET, PairingStore, RateLimiter, generateCode, generateToken, loadOrCreateSecret, normalizeCode,
  sha256Hex, signTicket, verifyTicket,
} from './auth';
import { writeJsonAtomic } from './store';
import { removeDir, tempDir, writeFile } from './test-helpers';

const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let clock: number;
const now = (): number => clock;

beforeEach(() => {
  dir = tempDir();
  clock = Date.parse('2026-03-01T12:00:00Z');
});
afterEach(() => removeDir(dir));

describe('codes', () => {
  it('have the form XXXX-XXXX-XXXX in the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect([...code.replaceAll('-', '')].every((letter) => CODE_ALPHABET.includes(letter))).toBe(true);
    }
    expect(CODE_ALPHABET).not.toMatch(/[IO01]/);
  });

  it('are read whatever the case, spaces or dashes', () => {
    expect(normalizeCode(' abcd efgh-jkmn ')).toBe('ABCD-EFGH-JKMN');
    expect(normalizeCode('ABCDEFGHJKMN')).toBe('ABCD-EFGH-JKMN');
    expect(normalizeCode('ABCD-EFGH-JKM')).toBeNull();
    expect(normalizeCode('ABCD-EFGH-JK10')).toBeNull();
  });

  it('pair one device, once', () => {
    const store = new PairingStore(dir, now);
    const { code, expiresAt } = store.createCode();
    expect(Date.parse(expiresAt) - clock).toBe(3 * DAY);

    const paired = store.redeem(code.toLowerCase(), 'Kitchen tablet');
    expect(paired?.device.name).toBe('Kitchen tablet');
    expect(store.redeem(code, 'Second try')).toBeNull();
    expect(store.listDevices()).toHaveLength(1);
  });

  it('stop working when they expire', () => {
    const store = new PairingStore(dir, now);
    const { code } = store.createCode(2);
    clock += 2 * DAY;
    expect(store.redeem(code, 'Late')).toBeNull();
    const other = store.createCode(2);
    clock += 2 * DAY - 1000;
    expect(store.redeem(other.code, 'In time')).not.toBeNull();
  });

  it('are wrong when they are wrong', () => {
    const store = new PairingStore(dir, now);
    store.createCode();
    expect(store.redeem('AAAA-AAAA-AAAA', 'Guess')).toBeNull();
    expect(store.redeem('', 'Guess')).toBeNull();
    expect(store.listDevices()).toEqual([]);
  });

  it('are stored only as hashes, as are tokens', () => {
    const store = new PairingStore(dir, now);
    const first = store.createCode();
    const second = store.createCode();
    const paired = store.redeem(second.code, 'Phone')!;
    const text = readFileSync(path.join(dir, 'pairing.json'), 'utf8');
    expect(text).not.toContain(first.code);
    expect(text).not.toContain(paired.token);
    expect(text).toContain(sha256Hex(first.code));
    expect(text).toContain(sha256Hex(paired.token));
    // The atomic write leaves no temporary file behind.
    expect(readdirSync(dir)).toEqual(['pairing.json']);
  });
});

describe('devices', () => {
  it('are found by their token and by nothing else', () => {
    const store = new PairingStore(dir, now);
    const paired = store.redeem(store.createCode().code, 'Phone')!;
    expect(paired.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.authenticate(paired.token)?.id).toBe(paired.device.id);
    expect(store.authenticate(generateToken())).toBeNull();
    expect(store.authenticate(paired.token.slice(0, -1))).toBeNull();
    expect(store.authenticate('')).toBeNull();
  });

  it('record when they were last seen', () => {
    const store = new PairingStore(dir, now);
    const paired = store.redeem(store.createCode().code, 'Phone')!;
    clock += 5 * 60_000;
    store.authenticate(paired.token);
    expect(store.listDevices()[0].lastSeenAt).toBe(new Date(clock).toISOString());
    expect(store.listDevices()[0].pairedAt).toBe(paired.device.pairedAt);
  });

  it('are removed by id, and found by id or name', () => {
    const store = new PairingStore(dir, now);
    const phone = store.redeem(store.createCode().code, 'Phone')!;
    const laptop = store.redeem(store.createCode().code, 'Laptop')!;
    expect(store.findDevices('phone').map((device) => device.id)).toEqual([phone.device.id]);
    expect(store.findDevices(laptop.device.id).map((device) => device.name)).toEqual(['Laptop']);
    expect(store.findDevices('Television')).toEqual([]);

    expect(store.removeDevice(phone.device.id)).toBe(true);
    expect(store.removeDevice(phone.device.id)).toBe(false);
    expect(store.authenticate(phone.token)).toBeNull();
    expect(store.authenticate(laptop.token)).not.toBeNull();
  });

  it('are seen by a second store on the same folder (a subcommand beside the server)', () => {
    const server = new PairingStore(dir, now);
    const cli = new PairingStore(dir, now);
    const { code } = cli.createCode();
    const paired = server.redeem(code, 'Phone')!;
    expect(cli.listDevices().map((device) => device.name)).toEqual(['Phone']);
    cli.removeDevice(paired.device.id);
    expect(server.authenticate(paired.token)).toBeNull();
  });

  it('are not silently lost when the store is damaged', () => {
    writeFile(path.join(dir, 'pairing.json'), '{ not json');
    expect(() => new PairingStore(dir, now).listDevices()).toThrow(/damaged/);
  });
});

describe('the store file', () => {
  it('is replaced whole', () => {
    const file = path.join(dir, 'nested', 'value.json');
    writeJsonAtomic(file, { a: 1 });
    writeJsonAtomic(file, { a: 2 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 2 });
    expect(readdirSync(path.dirname(file))).toEqual(['value.json']);
  });
});

describe('the secret', () => {
  it('is made once and read back afterwards', () => {
    const data = path.join(dir, 'data');
    const first = loadOrCreateSecret(data);
    expect(first).toHaveLength(32);
    expect(loadOrCreateSecret(data).equals(first)).toBe(true);
    expect(existsSync(path.join(data, 'secret.key'))).toBe(true);
    if (process.platform !== 'win32') expect(statSync(path.join(data, 'secret.key')).mode & 0o777).toBe(0o600);
  });

  it('is refused when damaged', () => {
    writeFile(path.join(dir, 'secret.key'), 'short');
    expect(() => loadOrCreateSecret(dir)).toThrow(/damaged/);
  });
});

describe('tickets', () => {
  const secret = Buffer.alloc(32, 7);
  const id = '0123456789abcdef';
  const exp = 2_000_000_000;

  it('verify until they expire', () => {
    const sig = signTicket(secret, id, exp);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyTicket(secret, id, String(exp), sig, exp - 1)).toBe('ok');
    expect(verifyTicket(secret, id, String(exp), sig, exp)).toBe('expired');
    expect(verifyTicket(secret, id, String(exp), sig, exp + 100)).toBe('expired');
  });

  it('fail when anything is changed', () => {
    const sig = signTicket(secret, id, exp);
    const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
    expect(verifyTicket(secret, id, String(exp), flipped, 0)).toBe('bad');
    expect(verifyTicket(secret, id, String(exp + 3600), sig, 0)).toBe('bad');
    expect(verifyTicket(secret, 'fedcba9876543210', String(exp), sig, 0)).toBe('bad');
    expect(verifyTicket(Buffer.alloc(32, 8), id, String(exp), sig, 0)).toBe('bad');
    expect(verifyTicket(secret, id, String(exp), sig.toUpperCase(), 0)).toBe('bad');
    expect(verifyTicket(secret, id, '', sig, 0)).toBe('bad');
    expect(verifyTicket(secret, id, `${exp}.0`, sig, 0)).toBe('bad');
    expect(verifyTicket(secret, id, String(exp), '', 0)).toBe('bad');
    expect(verifyTicket(secret, id, String(exp), sig.slice(0, 32), 0)).toBe('bad');
  });
});

describe('RateLimiter', () => {
  it('allows a number of attempts per window, per key', () => {
    const limiter = new RateLimiter(3, 1000);
    expect([0, 1, 2].map((at) => limiter.allow('a', at))).toEqual([true, true, true]);
    expect(limiter.allow('a', 3)).toBe(false);
    expect(limiter.allow('b', 3)).toBe(true);
    expect(limiter.allow('a', 999)).toBe(false);
    expect(limiter.allow('a', 1000)).toBe(true);
    expect(limiter.allow('a', 1000)).toBe(false);
  });
});
