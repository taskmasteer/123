import { readFile, writeFile, mkdir, copyFile, cp, readdir, lstat, readlink, symlink, chmod, stat, rm, realpath } from 'node:fs/promises';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { targetInfo, targets, nodeVersion, playwrightVersion, chromiumVersion, chromiumRevision, workspaceClosure, verifyStagedDependencies, contained, hashFile, sha256, binaryHeader, checkArchitecture, inventoryRuntime } from './package-runtime.mjs';
import { officialResponse, verifiedArchive, extractZip, extractTarGz, requireSpace } from './package-download.mjs';

export function argumentsFor(argv = process.argv.slice(2)) {
  const target = argv[argv.indexOf('--target') + 1]; targetInfo(target);
  return { target, offline: argv.includes('--offline'), recordSource: argv.includes('--record-source'), archivesOnly: argv.includes('--archives-only') };
}
export async function sourceLock(options) {
  const path = resolve('scripts/runtime-sources.lock.json'); let lock;
  try { lock = JSON.parse(await readFile(path)); } catch (e) { if (e.code !== 'ENOENT') throw e; lock = { format: 1, node: nodeVersion, playwright: playwrightVersion, chromiumRevision, chromiumVersion, targets: {} }; }
  if (lock.format !== 1 || lock.node !== nodeVersion || lock.playwright !== playwrightVersion || lock.chromiumRevision !== chromiumRevision || lock.chromiumVersion !== chromiumVersion) throw new Error('Runtime source lock version mismatch');
  if (options.recordSource && !lock.nodeSums) {
    if (options.offline) throw new Error('Cannot record official sums offline');
    const url = `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`, { response, finalUrl } = await officialResponse(url), bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 100000) throw new Error('Official sums too large');
    lock.nodeSums = { url, finalUrl, sha256: sha256(bytes), retrievedAt: new Date().toISOString(), trust: 'expected SHA256 from official Node HTTPS release SHASUMS256.txt; no signature verification claimed' };
    const sums = bytes.toString('utf8');
    for (const [target, info] of Object.entries(targets)) {
      const line = sums.split('\n').find(line => line.trim().endsWith('  ' + info.nodeArchive));
      if (!line || !/^[a-f0-9]{64}  /.test(line)) throw new Error('Exact pinned Node archive absent from official sums');
      lock.targets[target] = { node: { url: `https://nodejs.org/dist/v${nodeVersion}/${info.nodeArchive}`, sha256: line.slice(0, 64), provenance: { trust: 'official Node SHASUMS256.txt', source: url, sumsSha256: sha256(bytes) } }, browsers: browserSources(info) };
    }
  }
  if (!lock.targets[options.target]?.node?.sha256) throw new Error('Reviewed Node source lock missing; prepare with --record-source once');
  return { lock, save: async () => writeFile(path, JSON.stringify(lock, null, 2) + '\n') };
}
function browserSources(info) {
  const platform = info.platform, full = platform === 'win64' ? 'chrome-win64.zip' : `chrome-${platform}.zip`, shell = platform === 'win64' ? 'chrome-headless-shell-win64.zip' : `chrome-headless-shell-${platform}.zip`;
  const result = [
    { name: 'chromium', revision: '1248', directory: 'chromium-1248', url: `https://cdn.playwright.dev/builds/cft/${chromiumVersion}/${platform}/${full}`, sha256: null },
    { name: 'chromium-headless-shell', revision: '1248', directory: 'chromium_headless_shell-1248', url: `https://cdn.playwright.dev/builds/cft/${chromiumVersion}/${platform}/${shell}`, sha256: null },
    { name: 'ffmpeg', revision: '1013', directory: 'ffmpeg-1013', url: `https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1013/ffmpeg-${info.os === 'win32' ? 'win64' : info.arch === 'arm64' ? 'mac-arm64' : 'mac'}.zip`, sha256: null },
  ];
  if (info.os === 'win32') result.push({ name: 'winldd', revision: '1007', directory: 'winldd-1007', url: 'https://cdn.playwright.dev/dbazure/download/playwright/builds/winldd/1007/winldd-win64.zip', sha256: null });
  return result;
}
export async function safeRemoveOwned(parent, path, prefix) { const expected = resolve(parent); if (!resolve(path).startsWith(expected + sep + prefix)) throw new Error('Refused unowned temporary cleanup'); await rm(path, { recursive: true, force: true }); }
export async function copyTree(source, destination, skipModules = false) {
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(source)) {
    if (skipModules && name === 'node_modules') continue;
    const src = join(source, name), dest = join(destination, name), s = await lstat(src);
    if (s.isDirectory()) await copyTree(src, dest, skipModules);
    else if (s.isSymbolicLink()) { const link = await readlink(src); contained(source, resolve(dirname(src), link)); await symlink(link, dest); }
    else if (s.isFile()) { await copyFile(src, dest); await chmod(dest, s.mode & 0o777); }
    else throw new Error('Unsupported source resource');
  }
}
async function packageDirectory(name, from) {
  let at = from;
  for (;;) { const candidate = join(at, 'node_modules', name, 'package.json'); try { await stat(candidate); return dirname(candidate); } catch (e) { if (e.code !== 'ENOENT') throw e; } const parent = dirname(at); if (parent === at) throw new Error('Missing locked runtime dependency: ' + name); at = parent; }
}
async function vendors(names, runtime, target) {
  const root = resolve('.'), lock = JSON.parse(await readFile('package-lock.json')), visited = new Set(), licenses = [], omitted = [], info = targetInfo(target);
  async function visit(name, from, optional = false) {
    let dir; try { dir = await packageDirectory(name, from); } catch (e) { if (optional) { omitted.push({ name, reason: 'optional package absent; browser runtime does not use optional watcher features' }); return; } throw e; }
    const rel = contained(root, dir); if (visited.has(rel)) return;
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'))), pinned = lock.packages[rel];
    const compatible = (key, actual) => !pkg[key] || (!pkg[key].includes('!' + actual) && (pkg[key].every(v => v.startsWith('!')) || pkg[key].includes(actual)));
    if (!compatible('os', info.os) || !compatible('cpu', info.arch)) { if (!optional) throw new Error('Required dependency target mismatch: ' + name); omitted.push({ name, reason: 'optional dependency incompatible with target' }); return; }
    if (!pinned || pinned.version !== pkg.version || !pinned.integrity) throw new Error('Runtime package not pinned in lock: ' + rel);
    visited.add(rel); await copyTree(dir, join(runtime, rel), true);
    licenses.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'SEE SHIPPED LICENSE', integrity: pinned.integrity, path: rel });
    for (const dep of Object.keys(pkg.dependencies ?? {})) await visit(dep, dir, Object.hasOwn(pkg.optionalDependencies ?? {}, dep));
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) if (!Object.hasOwn(pkg.dependencies ?? {}, dep)) await visit(dep, dir, true);
  }
  for (const name of names) await visit(name, root);
  return { packages: licenses.sort((a, b) => a.name.localeCompare(b.name)), optionalOmissions: omitted };
}
export async function prepareRuntime(options) {
  const info = targetInfo(options.target), { lock, save } = await sourceLock(options), base = resolve('.local-state/package', options.target), runtime = join(base, 'runtime');
  await mkdir(base, { recursive: true }); await requireSpace(base, 0);
  const node = lock.targets[options.target].node, cached = { ...node, cache: resolve('.local-state/runtime-cache', options.target, info.nodeArchive) };
  const archive = await verifiedArchive(cached, options);
  if(options.archivesOnly){await save();return {target:options.target,archive,nodeSha256:node.sha256};}
  await mkdir(runtime, { recursive: true }); await mkdir(join(runtime, 'licenses'), { recursive: true });
  {
    const prefix=info.nodeArchive.replace(/\.(zip|tar.gz)$/,''),binary=prefix+'/'+(info.os==='win32'?'node.exe':'bin/node'),license=prefix+'/LICENSE',select=new Set([binary,license]),selected=new Map();
    // Ship only these official Node resources; npm, headers and sample trees are
    // not runtime dependencies and need not consume a second temporary tree.
    const onFile=file=>{if(file.kind!=='file')throw Error('Node resource is not a regular file');selected.set(file.path,file.bytes);};
    if (archive.endsWith('.zip')) await extractZip(archive,undefined,{select,onFile}); else await extractTarGz(archive,undefined,{select,onFile});
    if(selected.size!==2)throw Error('Official Node binary/license missing');checkArchitecture(selected.get(binary).subarray(0,65536),options.target);
    const writes=[[join(runtime,info.node),selected.get(binary)],[join(runtime,'licenses/node-LICENSE'),selected.get(license)]],changed=[];
    for(const [path,bytes] of writes){try{if(await hashFile(path)===sha256(bytes))continue;}catch(e){if(e.code!=='ENOENT')throw e;}changed.push([path,bytes]);}
    await requireSpace(base,changed.reduce((n,[,bytes])=>n+bytes.length,0));
    for(const [path,bytes] of changed)await writeFile(path,bytes);await chmod(join(runtime,info.node),0o755);
  }
  const closure = await workspaceClosure(resolve('dist'));
  for (const file of closure.files) { await mkdir(dirname(join(runtime, file)), { recursive: true }); await copyFile(join('dist', file), join(runtime, file)); }
  const dependencies = await vendors(closure.packages, runtime, options.target);
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'site-factory-runtime', private: true, type: 'module', version: '0.1.0', engines: { node: '=' + nodeVersion } }, null, 2));
  await writeFile(join(runtime, 'licenses/runtime-dependencies.json'), JSON.stringify(dependencies, null, 2));
  await copyTree(resolve('templates'), join(runtime, 'templates')); await copyTree(resolve('references'), join(runtime, 'references'));
  await verifyStagedDependencies(runtime);
  await save();
  return { target: options.target, runtime, nodeSha256: node.sha256, modules: closure.files.length, packages: dependencies.packages.length };
}
export async function prepareBrowsers(options) {
  const info = targetInfo(options.target), { lock, save } = await sourceLock(options), base = resolve('.local-state/package', options.target), runtime = join(base, 'runtime');
  const browsers = JSON.parse(await readFile('node_modules/playwright-core/browsers.json'));
  for (const name of ['chromium', 'chromium-headless-shell']) if (!browsers.browsers.some(b => b.name === name && b.revision === chromiumRevision && b.browserVersion === chromiumVersion)) throw new Error('Pinned browser metadata mismatch');
  await mkdir(base, { recursive: true });
  for (const item of lock.targets[options.target].browsers) {
    const cache = resolve('.local-state/runtime-cache', options.target, item.name + '-' + item.revision + '.zip');
    await verifiedArchive(Object.assign(item, { cache }), options); delete item.cache; await save();
    if(options.archivesOnly)continue;
    const dest = join(runtime, 'browsers', item.directory);
    await requireSpace(base, 1024 ** 3); const temp = join(base, 'browser-extract-' + randomUUID());
    try {
      await extractZip(cache, temp); await writeFile(join(temp, 'INSTALLATION_COMPLETE'), ''); await mkdir(dirname(dest), { recursive: true });
      let exists=false;try{await stat(dest);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
      if(exists){const expected=await inventoryRuntime(temp,{target:options.target}),actual=await inventoryRuntime(dest,{target:options.target});if(JSON.stringify(actual.files)!==JSON.stringify(expected.files))throw new Error('Existing browser stage differs from the verified official archive');}
      else await import('node:fs/promises').then(fs => fs.rename(temp, dest));
    }
    finally { await safeRemoveOwned(base, temp, 'browser-extract-'); }
  }
  return { target: options.target, browserRoot: join(runtime, 'browsers'), chromium: chromiumRevision, officialSourceLock: 'scripts/runtime-sources.lock.json' };
}
