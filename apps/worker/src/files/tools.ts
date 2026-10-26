import { randomUUID } from 'node:crypto';
import { lstat, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppError } from '../../../../packages/contracts/src/model.js';
import type { FileTools } from '../../../../packages/contracts/src/model.js';
import { artifactLimits, artifactPath } from '../../../../packages/core/src/artifacts.js';
import { privateDirectory, readRegular, safeFile, writeExclusive } from '../../../../packages/adapters/src/safe-files.js';

export async function createFileTools(directory: string): Promise<FileTools> {
  const root = await privateDirectory(directory); let tail: Promise<unknown> = Promise.resolve();
  function run<T>(operation: () => Promise<T>): Promise<T> { const result = tail.then(operation); tail = result.catch(() => undefined); return result; }
  async function list(): Promise<string[]> {
    await privateDirectory(root, false); const paths: string[] = []; let total = 0;
    async function visit(prefix: string) {
      const entries = await readdir(prefix ? join(root, prefix) : root); const folded = new Set<string>();
      for (const name of entries) {
        if (folded.has(name.toLowerCase())) throw new AppError('INVALID_INPUT', 'Case-colliding path.'); folded.add(name.toLowerCase());
        const path = prefix ? prefix + '/' + name : name; const stat = await lstat(join(root, path));
        if (stat.isSymbolicLink()) throw new AppError('INVALID_INPUT', 'Symlinks and junctions are forbidden.');
        if (stat.isDirectory()) {
          if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || /^(api|node_modules)$/i.test(name)) throw new AppError('INVALID_INPUT', 'Unsafe directory.');
          await visit(path);
        } else if (stat.isFile()) {
          artifactPath(path); paths.push(path); total += stat.size;
          if (stat.size > artifactLimits.fileBytes || paths.length > artifactLimits.files || total > artifactLimits.totalBytes) throw new AppError('INVALID_INPUT', 'File workspace exceeds limits.');
        } else throw new AppError('INVALID_INPUT', 'Only regular files are allowed.');
      }
    }
    await visit(''); return paths.sort();
  }
  async function read(path: string): Promise<string> {
    artifactPath(path);
    return new TextDecoder('utf-8', { fatal: true }).decode(await readRegular(await safeFile(root, path), artifactLimits.fileBytes));
  }
  async function write(path: string, text: string): Promise<void> {
    artifactPath(path);
    if (typeof text !== 'string') throw new AppError('INVALID_INPUT', 'File contents must be text.');
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > artifactLimits.fileBytes) throw new AppError('INVALID_INPUT', 'File exceeds byte limit.');
    const paths = await list(); let total = bytes.byteLength;
    for (const existing of paths) {
      if (existing.toLowerCase() === path.toLowerCase() && existing !== path) throw new AppError('INVALID_INPUT', 'Case-colliding path.');
      if (existing !== path) total += (await lstat(join(root, existing))).size;
    }
    if (total > artifactLimits.totalBytes || (!paths.includes(path) && paths.length >= artifactLimits.files)) throw new AppError('INVALID_INPUT', 'File workspace exceeds limits.');
    const target = await safeFile(root, path, true); const temporary = join(dirname(target), '.write-' + randomUUID());
    try {
      await writeExclusive(temporary, bytes);
      await safeFile(root, path);
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  return {
    list: () => run(list), read: (path) => run(() => read(path)), write: (path, text) => run(() => write(path, text)),
    replace: (path, oldText, newText) => run(async () => {
      const current = await read(path);
      if (!oldText || current.split(oldText).length !== 2) throw new AppError('INVALID_INPUT', 'Replacement must match exactly once.');
      await write(path, current.replace(oldText, () => newText));
    }),
  };
}
