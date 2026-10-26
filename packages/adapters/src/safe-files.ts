import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, parse, relative, resolve, sep } from 'node:path';
import { AppError } from '../../contracts/src/model.js';

export function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }

/** Only private, process-owned trees are supported. Reject every encountered reparse point.
 * This does not defend against another process with the same OS identity replacing
 * ancestors between filesystem operations; that process already controls this worker.
 */
export async function privateDirectory(directory: string, create = true): Promise<string> {
  const target = resolve(directory); let cursor = parse(target).root;
  for (const segment of relative(cursor, target).split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    let stat;
    try { stat = await lstat(cursor); }
    catch (error) {
      if (!create || !missing(error)) throw error;
      try { await mkdir(cursor, { mode: 0o700 }); } catch (failure) { if (!(failure instanceof Error && 'code' in failure && failure.code === 'EEXIST')) throw failure; }
      stat = await lstat(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AppError('INVALID_INPUT', 'Symlinks, junctions and non-directories are forbidden.');
  }
  return target;
}
export async function safeFile(root: string, path: string, createParents = false): Promise<string> {
  await privateDirectory(root, false);
  const parts = path.split('/'); let cursor = root;
  for (const [index, part] of parts.entries()) {
    const entries = await readdir(cursor);
    if (entries.some((entry) => entry.toLowerCase() === part.toLowerCase() && entry !== part)) throw new AppError('INVALID_INPUT', 'Case-colliding path.');
    cursor = join(cursor, part);
    const final = index === parts.length - 1;
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || (final ? !stat.isFile() : !stat.isDirectory())) throw new AppError('INVALID_INPUT', 'Non-regular artifact path.');
    } catch (error) {
      if (!missing(error)) throw error;
      if (!final) {
        if (!createParents) throw error;
        await mkdir(cursor, { mode: 0o700 });
      }
    }
  }
  return cursor;
}
export async function readRegular(path: string, limit: number): Promise<Uint8Array> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > limit) throw new AppError('INVALID_INPUT', 'Unsafe or oversized artifact object.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > limit || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new AppError('INVALID_INPUT', 'Artifact changed while opening.');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null); if (!result.bytesRead) break; size += result.bytesRead;
    }
    if (size > limit) throw new AppError('INVALID_INPUT', 'Artifact grew beyond the byte limit.');
    return new Uint8Array(bytes.subarray(0, size));
  } finally { await handle.close(); }
}
export async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
