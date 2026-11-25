/** Small JSON files in `DATA_DIR`, written so a reader never sees half a file. */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function isCode(error: unknown, ...codes: string[]): boolean {
  return typeof error === 'object' && error !== null && codes.includes((error as { code?: string }).code ?? '');
}

/** The parsed file, or `undefined` when there is none. A file that isn't JSON is an error, never silently replaced. */
export function readJsonFile(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (isCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is damaged (not JSON). Restore it from a backup, or delete it to start with no paired devices.`);
  }
}

/** Writes to a temporary file beside the target, then renames it over the target. */
export function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temp, file);
        return;
      } catch (error) {
        // Windows refuses the rename while another process (a subcommand, a virus scanner) has the target open.
        if (attempt >= 5 || !isCode(error, 'EPERM', 'EACCES', 'EBUSY')) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
