import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, lstat, symlink, chmod, rename, rm, statfs } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import yauzl from 'yauzl';
import { safeRelative, contained, hashFile, sha256 } from './package-runtime.mjs';

export async function requireSpace(path, additional) {
  const fs = await statfs(path); const free = fs.bavail * fs.bsize;
  if (free - additional < 2 * 1024 ** 3) throw new Error(`Package disk budget: ${free} free bytes; ${additional} planned additional bytes plus 2GiB floor required`);
  return free;
}
const officialHosts = new Set(['nodejs.org', 'cdn.playwright.dev', 'playwright.download.prss.microsoft.com', 'storage.googleapis.com', 'playwright2.blob.core.windows.net']);
export async function officialResponse(url, options = {}) {
  for (let redirects = 0; redirects < 6; redirects++) {
    const parsed = new URL(url); if (parsed.protocol !== 'https:' || !officialHosts.has(parsed.hostname) || parsed.username || parsed.password) throw new Error('Unreviewed runtime distribution URL');
    const response = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(180000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel(); url = new URL(response.headers.get('location'), url).href; continue; }
    if (!response.ok) throw new Error(`Official runtime source unavailable: ${response.status} ${url}`);
    return { response, finalUrl: url };
  }
  throw new Error('Too many distribution redirects');
}
export async function verifiedArchive(item, options = {}) {
  if (item.sha256 != null && !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid expected archive digest');
  try {
    await lstat(item.cache);
    if (!item.sha256) throw new Error('Existing cache has no trusted expected digest');
    if (await hashFile(item.cache) !== item.sha256) throw new Error('Cached archive digest mismatch');
    return item.cache;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (options.offline) throw new Error('Offline runtime archive missing');
  if (!item.sha256 && !options.recordSource) throw new Error('Expected archive digest missing; controlled source recording required');
  await mkdir(dirname(item.cache), { recursive: true }); await requireSpace(dirname(item.cache), 512 * 1024 ** 2);
  const { response, finalUrl } = await officialResponse(item.url), maximum = 512 * 1024 ** 2;
  if (Number(response.headers.get('content-length')) > maximum) throw new Error('Archive download exceeds preparation budget');
  let bytes = 0; const temp = item.cache + '.partial-' + process.pid;
  try {
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(part, _, done) { bytes += part.length; done(bytes > maximum ? new Error('Archive download bound exceeded') : null, part); } }), createWriteStream(temp, { flags: 'wx' }));
    const digest = await hashFile(temp);
    if (item.sha256 && item.sha256 !== digest) throw new Error('Downloaded archive digest mismatch');
    if (!item.sha256) { item.sha256 = digest; item.provenance = { trust: 'controlled official HTTPS retrieval; not an upstream published checksum', url: item.url, finalUrl, retrievedAt: new Date().toISOString(), bytes }; }
    await rename(temp, item.cache); return item.cache;
  } finally { await rm(temp, { force: true }); }
}
async function directory(root, path) {
  await mkdir(root, { recursive: true }); const rel = path === root ? '' : contained(root, path);
  let current = root;
  for (const part of rel.split('/').filter(Boolean)) {
    current = join(current, part);
    try { const s = await lstat(current); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Archive parent path is not a real directory'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; await mkdir(current); }
  }
}
async function entry(root, name, bytes, mode, kind, link, seen) {
  name = name.replace(/\/$/, ''); safeRelative(name); const key = name.toLowerCase();
  if (seen.has(key)) throw new Error('Duplicate/case-colliding archive path'); seen.add(key);
  const path = resolve(root, name); contained(root, path); await directory(root, dirname(path));
  if (kind === 'directory') { await directory(root, path); return; }
  if (kind === 'symlink') {
    if (!link || /[\x00-\x1f]/.test(link) || link.startsWith('/') || link.includes('\\') || /^[A-Za-z]:/.test(link)) throw new Error('Unsafe symlink path');
    contained(root, resolve(dirname(path), link)); await symlink(link, path); return;
  }
  if (kind !== 'file') throw new Error('Unsupported archive entry type');
  await writeFile(path, bytes, { flag: 'wx', mode: mode & 0o777 }); await chmod(path, mode & 0o777);
}
export async function extractZip(path, root, options={}) {
  const zip = await new Promise((ok, bad) => yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (e, z) => e ? bad(e) : ok(z)));
  const seen = new Set(),allNames=new Set(); let total = 0, count = 0;
  try {
    await new Promise((ok, bad) => {
      zip.on('error', bad); zip.on('end', ok); zip.on('entry', async file => {
        try {
          if (++count > 100000 || (total += file.uncompressedSize) > 1536 * 1024 ** 2 || file.uncompressedSize > 512 * 1024 ** 2 || file.generalPurposeBitFlag & 1) throw new Error('Archive extraction bounds exceeded');
          const mode = file.externalFileAttributes >>> 16, type = mode & 0o170000;
          const kind = file.fileName.endsWith('/') ? 'directory' : type === 0o120000 ? 'symlink' : type && type !== 0o100000 ? 'unsupported' : 'file';
          const name=file.fileName.replace(/\/$/,'');safeRelative(name);const key=name.toLowerCase();if(allNames.has(key))throw Error('Duplicate/case-colliding archive path');allNames.add(key);
          if(kind==='unsupported')throw Error('Unsupported archive entry type');
          const selected=!options.select||options.select.has(file.fileName);
          if(!selected&&kind!=='symlink'){zip.readEntry();return;}
          const parts = []; let stream;
          if (kind !== 'directory') {
            stream = await new Promise((yes, no) => zip.openReadStream(file, (e, s) => e ? no(e) : yes(s)));
            let size = 0; for await (const part of stream) { size += part.length; if (size > file.uncompressedSize) throw new Error('ZIP entry size mismatch'); parts.push(part); }
            if (size !== file.uncompressedSize) throw new Error('ZIP entry truncated');
          }
          const bytes = Buffer.concat(parts);
          if(kind==='symlink'){const link=new TextDecoder('utf8',{fatal:true}).decode(bytes);if(!link||/[\x00-\x1f\\]/.test(link)||link.startsWith('/')||/^[A-Za-z]:/.test(link))throw Error('Unsafe symlink path');contained(root??resolve('.archive-inspection'),resolve(root??resolve('.archive-inspection'),dirname(name),link));}
          if(!selected){zip.readEntry();return;}
          if(options.onFile)await options.onFile({path:file.fileName,bytes,mode,kind});
          else await entry(root, file.fileName, bytes, mode || 0o644, kind, kind === 'symlink' ? new TextDecoder('utf8', { fatal: true }).decode(bytes) : '', seen);
          zip.readEntry();
        } catch (e) { zip.close(); bad(e); }
      }); zip.readEntry();
    });
  } finally { zip.close(); }
}
function tarText(bytes) { return bytes.toString('utf8').split('\0')[0]; }
export async function extractTarGz(input, root, options={}) {
  const bytes = gunzipSync(typeof input === 'string' ? await readFile(input) : input, { maxOutputLength: 512 * 1024 ** 2 }), seen = new Set();
  let at = 0, extended = {}, longName, longLink, count = 0;const allNames=new Set();
  while (at + 512 <= bytes.length) {
    const header = bytes.subarray(at, at + 512); at += 512; if (header.every(b => b === 0)) break;
    if (++count > 100000) throw new Error('TAR entry bound exceeded');
    const size = parseInt(tarText(header.subarray(124, 136)).trim() || '0', 8), mode = parseInt(tarText(header.subarray(100, 108)).trim() || '644', 8), type = String.fromCharCode(header[156] || 48);
    if (!Number.isSafeInteger(size) || size < 0 || at + size > bytes.length) throw new Error('Invalid TAR size');
    const body = bytes.subarray(at, at + size); at += Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = tarText(body); continue; } if (type === 'K') { longLink = tarText(body); continue; }
    if (type === 'x' || type === 'g') {
      let pos = 0; while (pos < body.length) { const space = body.indexOf(32, pos), n = Number(body.subarray(pos, space).toString()); if (!Number.isInteger(n) || n <= 0 || pos + n > body.length) throw new Error('Invalid PAX record'); const line = body.subarray(space + 1, pos + n - 1).toString(), equal = line.indexOf('='); extended[line.slice(0, equal)] = line.slice(equal + 1); pos += n; } continue;
    }
    const prefix = tarText(header.subarray(345, 500)), name = extended.path ?? longName ?? ((prefix ? prefix + '/' : '') + tarText(header.subarray(0, 100))), link = extended.linkpath ?? longLink ?? tarText(header.subarray(157, 257));
    safeRelative(name.replace(/\/$/,''));
    const key=name.replace(/\/$/,'').toLowerCase();if(allNames.has(key))throw Error('Duplicate/case-colliding archive path');allNames.add(key);
    if(!['0','2','5'].includes(type))throw Error('Unsupported archive entry type');
    if(type==='2'){if(!link||/[\x00-\x1f\\]/.test(link)||link.startsWith('/')||/^[A-Za-z]:/.test(link))throw Error('Unsafe symlink path');contained(root??resolve('.archive-inspection'),resolve(root??resolve('.archive-inspection'),dirname(name),link));}
    if(!options.select||options.select.has(name)){
      if(options.onFile)await options.onFile({path:name,bytes:body,mode,kind:type==='0'?'file':type==='5'?'directory':type==='2'?'symlink':'unsupported'});
      else await entry(root, name, body, mode, type === '5' ? 'directory' : type === '2' ? 'symlink' : type === '0' ? 'file' : 'unsupported', link, seen);
    }
    extended = {}; longName = undefined; longLink = undefined;
  }
}
