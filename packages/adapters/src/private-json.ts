import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../../contracts/src/model.js';
import { missing, privateDirectory, readRegular, safeFile, writeExclusive } from './safe-files.js';

const tails = new Map<string, Promise<unknown>>();
const maximumBytes = 2_000_000;
/** Serial, atomic local transactions for a single controlling process, not a cross-process database. */
export async function privateJson<T>(directory: string, name: string, initial: T, parse: (value: unknown) => T) {
  const root = await privateDirectory(directory); const path = join(root, name); const key = process.platform === 'win32' ? path.toLowerCase() : path;
  async function read(): Promise<T> {
    try { return parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readRegular(await safeFile(root, name), maximumBytes))) as unknown); }
    catch (error) { if (missing(error)) return structuredClone(initial); throw error; }
  }
  async function write(value: T) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (bytes.byteLength > maximumBytes) throw new AppError('INVALID_INPUT', 'Local JSON state exceeds the 2,000,000-byte capacity; the previous state was preserved.');
    const temporary = join(root, '.json-' + randomUUID());
    try {
      await writeExclusive(temporary, bytes);
      await safeFile(root, name); await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  await read();
  return {
    async transaction<R>(operation: (value: T) => Promise<{ value?: T; result: R }> | { value?: T; result: R }): Promise<R> {
      const result = (tails.get(key) ?? Promise.resolve()).then(async () => {
        const outcome = await operation(await read()); if (outcome.value !== undefined) await write(parse(outcome.value)); return outcome.result;
      });
      const settled = result.catch(() => undefined); tails.set(key, settled);
      void settled.finally(() => { if (tails.get(key) === settled) tails.delete(key); }); return result;
    },
  };
}
