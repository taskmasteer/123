import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileTools } from '../src/files/tools.js';
import { createLocalArtifacts } from '../../../packages/adapters/src/local-artifacts.js';
import { artifactPath } from '../../../packages/core/src/artifacts.js';
import { cleanDirectories, directory, file, site } from './fixtures.js';
afterEach(cleanDirectories);

describe('constrained file tools', () => {
  // Removing containment validation must allow these inputs and fail this test.
  it.each(['../outside.css', '/root.css', 'C:\\Users\\secret.css', 'C:secret.css', '\\\\server\\share\\x.css', '%2e%2e/x.css', '%252e%252e/x.css', 'a/../x.css', 'a\\x.css', 'a//x.css', 'CON.css', 'a.css:secret', 'x.css.', 'a/./x.css'])('rejects unsafe path %s for reads and writes', async (path) => {
    const tools = await createFileTools(await directory());
    await expect(tools.write(path, 'x')).rejects.toThrow();
    await expect(tools.read(path)).rejects.toThrow();
  });
  // Removing the allowlist would enable executable/config output.
  it.each(['package.json', 'api/run.js', 'vercel.json', 'run.exe', 'run.ps1', '.env', 'node_modules/x.js'])('rejects non-static output %s', async (path) => {
    const tools = await createFileTools(await directory());
    await expect(tools.write(path, 'x')).rejects.toThrow();
  });
  // Catches blind replace, lost persisted text, and unsorted listing.
  it('persists text and replaces exactly one unambiguous occurrence', async () => {
    const root = await directory(); const tools = await createFileTools(root);
    await tools.write('styles/main.css', 'body{color:red}'); await tools.write('index.html', '<h1>Hello</h1>');
    await tools.replace('index.html', 'Hello', 'Welcome');
    expect(await tools.list()).toEqual(['index.html', 'styles/main.css']);
    expect(await tools.read('index.html')).toBe('<h1>Welcome</h1>');
    expect(await readFile(join(root, 'index.html'), 'utf8')).toBe('<h1>Welcome</h1>');
    await expect(tools.replace('index.html', 'missing', 'x')).rejects.toThrow();
    await tools.write('same.js', 'x x'); await expect(tools.replace('same.js', 'x', 'y')).rejects.toThrow();
  });
  // Catches case-fold collisions on both Windows and case-sensitive hosts.
  it('rejects distinct paths differing only by case', async () => {
    const tools = await createFileTools(await directory()); await tools.write('Logo.css', 'a{}');
    await expect(tools.write('logo.css', 'b{}')).rejects.toThrow();
  });
  // Catches a junction escape even though the input path itself is relative.
  it('rejects junction directories and a junction used as the root', async () => {
    const root = await directory(); const outside = await directory();
    await writeFile(join(outside, 'secret.css'), 'private');
    await symlink(outside, join(root, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
    const tools = await createFileTools(root);
    await expect(tools.read('assets/secret.css')).rejects.toThrow();
    await expect(tools.write('assets/x.css', 'x')).rejects.toThrow();
    await expect(tools.list()).rejects.toThrow();
    await expect(createFileTools(join(root, 'assets'))).rejects.toThrow();
    expect(await readdir(outside)).toEqual(['secret.css']);
  });
  // Catches unbounded model output and null-byte input.
  it('bounds file bytes and rejects nulls', async () => {
    const tools = await createFileTools(await directory());
    await expect(tools.write('large.js', 'x'.repeat(2_000_001))).rejects.toThrow();
    expect(() => artifactPath('x\0.css')).toThrow();
  });
  // Catches following a file symlink even when no directory itself is a junction.
  it('rejects a symlink file before reading or overwriting its target', async ({ skip }) => {
    const root = await directory(); const outside = await directory();
    await writeFile(join(outside, 'secret.css'), 'private');
    try { await symlink(join(outside, 'secret.css'), join(root, 'linked.css'), 'file'); }
    catch (error) {
      if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') {
        skip('This Windows account lacks file-symlink privilege; junction coverage still runs.'); return;
      }
      throw error;
    }
    const tools = await createFileTools(root);
    await expect(tools.read('linked.css')).rejects.toThrow(); await expect(tools.write('linked.css', 'changed')).rejects.toThrow();
    expect(await readFile(join(outside, 'secret.css'), 'utf8')).toBe('private');
  });
});

describe('immutable artifact manifests', () => {
  // Catches memory-only storage, hashing wrong bytes, or mutable input aliases.
  it('roundtrips persisted bytes with independently known checksums', async () => {
    const root = await directory(); const store = await createLocalArtifacts(root, { now: () => 1800000000000 });
    const original = [file('index.html', 'abc')]; const saved = await store.put('site-a', original, 'v1');
    expect(saved.files[0]).toMatchObject({ path: 'index.html', size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d', mediaType: 'text/html' });
    expect(saved.createdAt).toBe(1800000000000);
    expect(await (await createLocalArtifacts(root)).read(saved.id)).toEqual(original);
    original[0]!.bytes[0] = 0; expect((await store.read(saved.id))[0]!.bytes).toEqual(new Uint8Array([97, 98, 99]));
  });
  // Catches trusting object bytes after disk corruption.
  it('rejects corrupt object bytes', async () => {
    const root = await directory(); const store = await createLocalArtifacts(root); const saved = await store.put('s', site(), 'v1');
    await writeFile(join(root, saved.files[0]!.objectKey), 'corrupt');
    await expect(store.read(saved.id)).rejects.toThrow();
  });
  // Catches returning an unfinished manifest after commit failure/restart.
  it('preserves prior manifests when an atomic commit is interrupted', async () => {
    const root = await directory(); const good = await createLocalArtifacts(root); const saved = await good.put('s', site(), 'v1');
    const id = '00000000-0000-4000-8000-000000000001';
    await mkdir(join(root, 'manifests'), { recursive: true }); await writeFile(join(root, 'manifests', id), 'block commit');
    const store = await createLocalArtifacts(root, undefined, { next: () => id });
    await expect(store.put('s', [file('index.html', 'new')], 'v1')).rejects.toThrow();
    const reopened = await createLocalArtifacts(root);
    expect(await reopened.read(saved.id)).toEqual(site()); await expect(reopened.read(id)).rejects.toThrow();
    expect((await readdir(root)).some((name) => name.startsWith('.staging-'))).toBe(false);
  });
  // Catches accepting path aliases and duplicate entries at the storage boundary.
  it('rejects duplicate case paths and traversal before saving', async () => {
    const store = await createLocalArtifacts(await directory());
    await expect(store.put('s', [file('index.html', 'x'), file('INDEX.html', 'y')], 'v1')).rejects.toThrow();
    await expect(store.put('s', [file('../index.html', 'x')], 'v1')).rejects.toThrow();
    await expect(store.read('../x')).rejects.toThrow();
  });
  // Catches order-dependent file/directory aliases inside immutable manifests.
  it('rejects a file used as a parent directory in either input order', async () => {
    const store = await createLocalArtifacts(await directory());
    await expect(store.put('s', [file('a.css', 'x'), file('a.css/b.js', 'y')], 'v1')).rejects.toThrow();
    await expect(store.put('s', [file('a.css/b.js', 'y'), file('a.css', 'x')], 'v1')).rejects.toThrow();
  });
  // Catches trusting serialized objectKey paths after manifest corruption.
  it('rejects forged manifest object keys before reading outside the manifest', async () => {
    const root = await directory(); const store = await createLocalArtifacts(root); const saved = await store.put('s', site(), 'v1');
    const manifestPath = join(root, 'manifests', saved.id, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files[0].objectKey = '../../secret.css'; await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(store.read(saved.id)).rejects.toThrow();
  });
});
