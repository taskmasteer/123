import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, crc32 } from 'node:zlib';
import { extractZip, extractTarGz, verifiedArchive } from '../lib/package-download.mjs';
async function fixture(action) { const root = await mkdtemp(join(tmpdir(), 'sf-archive-test-')); try { await action(root); } finally { await rm(root, { recursive: true, force: true }); } }
function zip(name, bytes = Buffer.from('ok')) {
  const n = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(n.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(crc32(bytes), 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(n.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + n.length, 12); end.writeUInt32LE(local.length + n.length + bytes.length, 16);
  return Buffer.concat([local, n, bytes, central, n, end]);
}
test('ZIP extraction writes contained bytes and rejects traversal before creating outside files', async () => fixture(async root => {
  const path = join(root, 'archive.zip'); await writeFile(path, zip('nested/file.txt'));
  await extractZip(path, join(root, 'output')); assert.equal(await readFile(join(root, 'output/nested/file.txt'), 'utf8'), 'ok');
  await writeFile(path, zip('../escape')); await assert.rejects(extractZip(path, join(root, 'bad')), /path|escape|invalid/i);
}));
test('tar extraction rejects escaping symbolic links', async () => fixture(async root => {
  const header = Buffer.alloc(512); header.write('link'); header.write('0000777\0', 100); header.write('00000000000\0', 124); header[156] = 50; header.write('../../outside', 157);
  await assert.rejects(extractTarGz(gzipSync(Buffer.concat([header, Buffer.alloc(1024)])), join(root, 'out')), /escape|path/i);
}));
test('offline cache cannot bless missing or changed bytes', async () => fixture(async root => {
  const item = { url: 'https://nodejs.org/dist/v24.21.0/test.zip', sha256: '0'.repeat(64), cache: join(root, 'cache.zip') };
  await assert.rejects(verifiedArchive(item, { offline: true }), /missing|offline/i);
  await writeFile(item.cache, 'corrupt'); await assert.rejects(verifiedArchive(item, { offline: true }), /digest|hash/i);
}));
