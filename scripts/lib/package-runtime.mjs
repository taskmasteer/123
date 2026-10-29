import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, lstat, readlink, realpath, open } from 'node:fs/promises';
import { resolve, relative, dirname, join, sep } from 'node:path';
import { isBuiltin } from 'node:module';
import ts from 'typescript';

export const nodeVersion = '24.21.0', playwrightVersion = '1.64.1', chromiumRevision = '1248', chromiumVersion = '156.0.8078.4';
export const targets = Object.freeze({
  'win32-x64': { os: 'win32', arch: 'x64', triple: 'x86_64-pc-windows-msvc', nodeArchive: 'node-v24.21.0-win-x64.zip', node: 'node.exe', platform: 'win64', chrome: 'chrome-win64/chrome.exe', shell: 'chrome-headless-shell-win64/chrome-headless-shell.exe' },
  'darwin-arm64': { os: 'darwin', arch: 'arm64', triple: 'aarch64-apple-darwin', nodeArchive: 'node-v24.21.0-darwin-arm64.tar.gz', node: 'node', platform: 'mac-arm64', chrome: 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', shell: 'chrome-headless-shell-mac-arm64/chrome-headless-shell' },
  'darwin-x64': { os: 'darwin', arch: 'x64', triple: 'x86_64-apple-darwin', nodeArchive: 'node-v24.21.0-darwin-x64.tar.gz', node: 'node', platform: 'mac-x64', chrome: 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', shell: 'chrome-headless-shell-mac-x64/chrome-headless-shell' },
});
export function targetInfo(target) { const info = targets[target]; if (!info) throw new Error('Unsupported package target: ' + target); return info; }
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function hashFile(path) { const hash = createHash('sha256'); for await (const part of createReadStream(path)) hash.update(part); return hash.digest('hex'); }
export function contained(root, path) { const rel = relative(resolve(root), resolve(path)); if (rel.startsWith('..' + sep) || rel === '..' || resolve(path) === resolve(root) || /^[A-Za-z]:/.test(rel)) throw new Error('Resource path escapes package root'); return rel.split(sep).join('/'); }
export function safeRelative(path) { if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..' || /[:\x00-\x1f]/.test(p))) throw new Error('Unsafe resource path: ' + path); return path; }
async function tree(root) {
  const files = [], names = new Set();
  async function visit(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), rel = contained(root, path); safeRelative(rel);
      if (rel === 'manifest.json') continue;
      if (names.has(rel.toLowerCase())) throw new Error('Case-colliding resource inventory'); names.add(rel.toLowerCase());
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        const link = await readlink(path); contained(root, resolve(dirname(path), link));
        const actual = await realpath(path); contained(root, actual);
        files.push({ path: rel, type: 'symlink', link: link.split(sep).join('/') });
      } else if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) files.push({ path: rel, type: 'file', size: stat.size, sha256: await hashFile(path), executable: !!(stat.mode & 0o111) });
      else throw new Error('Unsupported resource entry');
    }
  }
  await visit(root); return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export async function inventoryRuntime(root, metadata) { targetInfo(metadata.target); return { format: 1, node: nodeVersion, playwright: playwrightVersion, chromiumRevision, chromiumVersion, ...metadata, files: await tree(root) }; }
export function checkArchitecture(bytes, target) {
  const wanted = targetInfo(target), bad = () => { throw new Error('Executable architecture/header does not match ' + target); };
  if (bytes.length < 8) return bad();
  if (bytes.subarray(0, 2).toString() === 'MZ') {
    if (wanted.os !== 'win32' || bytes.length < 64) return bad(); const at = bytes.readUInt32LE(60);
    if (at + 6 > bytes.length || bytes.subarray(at, at + 4).toString() !== 'PE\0\0' || bytes.readUInt16LE(at + 4) !== 0x8664) return bad();
  } else {
    if (wanted.os !== 'darwin') return bad(); const cpu = wanted.arch === 'arm64' ? 0x0100000c : 0x01000007;
    if (bytes.readUInt32LE(0) === 0xfeedfacf) { if (bytes.length < 32 || bytes.readUInt32LE(4) !== cpu) return bad(); }
    else if ([0xcafebabe, 0xcafebabf].includes(bytes.readUInt32BE(0))) {
      const n = bytes.readUInt32BE(4), stride = bytes.readUInt32BE(0) === 0xcafebabf ? 32 : 20;
      if (n > 16 || bytes.length < 8 + n * stride || !Array.from({ length: n }, (_, i) => bytes.readUInt32BE(8 + i * stride)).includes(cpu)) return bad();
    } else return bad();
  }
  return true;
}
export async function binaryHeader(path) { const file = await open(path, 'r'); try { const buffer = Buffer.alloc(65536), { bytesRead } = await file.read(buffer, 0, buffer.length, 0); return buffer.subarray(0, bytesRead); } finally { await file.close(); } }
export async function checkRuntime(root, expected, options = {}) {
  if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('Independent manifest anchor is required');
  const bytes = await readFile(join(root, 'manifest.json')); if (bytes.length > 16 * 1024 ** 2 || sha256(bytes) !== expected) throw new Error('Runtime manifest anchor mismatch');
  const manifest = JSON.parse(bytes); const target = options.target ?? manifest.target, info = targetInfo(target);
  if (manifest.format !== 1 || manifest.target !== target || manifest.node !== nodeVersion || manifest.playwright !== playwrightVersion || manifest.chromiumRevision !== chromiumRevision || manifest.chromiumVersion !== chromiumVersion) throw new Error('Runtime manifest versions/target mismatch');
  const actual = await tree(root); if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Runtime inventory/hash/size mismatch');
  if (options.required !== false) {
    const required = [info.node, 'apps/worker/src/stdio.js', 'package.json', 'node_modules/playwright/package.json', 'node_modules/playwright-core/browsers.json', 'templates/catalog.json', 'references/catalog.json', 'licenses/runtime-dependencies.json', 'licenses/node-LICENSE', `browsers/chromium-1248/${info.chrome}`, `browsers/chromium_headless_shell-1248/${info.shell}`];
    for (const path of required) if (!actual.some(f => f.path === path)) throw new Error('Missing runtime resource: ' + path);
    if (JSON.parse(await readFile(join(root, 'package.json'))).type !== 'module' || JSON.parse(await readFile(join(root, 'node_modules/playwright/package.json'))).version !== playwrightVersion) throw new Error('Runtime ESM/Playwright metadata mismatch');
    const styles = JSON.parse(await readFile(join(root, 'templates/catalog.json'))), references = JSON.parse(await readFile(join(root, 'references/catalog.json')));
    if (styles.length !== 5 || references.length !== 14) throw new Error('Incomplete pinned catalog');
    for (const style of styles) for (const file of style.files) if (!actual.some(f => f.path === `templates/${style.id}/${file}`)) throw new Error('Missing pinned template');
    await verifyStagedDependencies(root, 'apps/worker/src/stdio.js');
    for (const file of actual) {
      if (file.type !== 'file') continue;
      const path = join(root, file.path), header = await binaryHeader(path);
      if (header.subarray(0, 2).toString() === 'MZ' || header.length >= 4 && [0xfeedfacf, 0xcafebabe, 0xcafebabf].some(m => header.readUInt32LE(0) === m || header.readUInt32BE(0) === m)) checkArchitecture(header, target);
      if (info.os === 'darwin' && [info.node, `browsers/chromium-1248/${info.chrome}`, `browsers/chromium_headless_shell-1248/${info.shell}`].includes(file.path) && !file.executable) throw new Error('Missing executable resource mode');
    }
  }
  return { ok: true, target, files: actual.length, bytes: actual.reduce((n, f) => n + (f.size ?? 0), 0), manifestSha256: expected, signature: manifest.signature ?? 'unsigned' };
}
export async function workspaceClosure(root, entry = 'apps/worker/src/stdio.js') {
  const files = new Set(), packages = new Set();
  async function visit(rel) {
    safeRelative(rel); if (files.has(rel)) return; files.add(rel);
    let text; try { text = await readFile(join(root, rel), 'utf8'); } catch { throw new Error('Cannot resolve workspace module: ' + rel); }
    const ast = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), specs = [];
    function scan(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specs.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) throw new Error('Nonliteral workspace import in ' + rel);
        specs.push(node.arguments[0].text);
      }
      ts.forEachChild(node, scan);
    }
    scan(ast);
    for (const spec of specs) {
      if (isBuiltin(spec)) continue;
      if (spec.startsWith('.')) await visit(contained(root, resolve(dirname(join(root, rel)), spec)));
      else if (spec.startsWith('/') || spec.includes(':')) throw new Error('Unsupported workspace import: ' + spec);
      else packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    }
  }
  await visit(entry); return { files: [...files].sort(), packages: [...packages].sort() };
}

export async function sourceIdentity(root) {
 const {execFileSync}=await import('node:child_process');
 const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
 const dirty=!!execFileSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
 const paths=[...new Set(execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8',windowsHide:true}).split('\0').filter(Boolean))].sort();
 const hash=createHash('sha256');
 for(const path of paths){safeRelative(path);hash.update(path+'\0');try{hash.update(sha256(await readFile(join(root,path))));}catch(error){if(error.code!=='ENOENT')throw error;hash.update('<deleted>');}hash.update('\0');}
 return {revision,dirty,fingerprint:hash.digest('hex')};
}
export async function verifyStagedDependencies(root, entry='apps/worker/src/stdio.js') {
 const closure=await workspaceClosure(root,entry), visited=new Set();root=await realpath(root);
 async function locate(name,from){
  if(!/^(@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name))throw Error('Invalid staged dependency');
  let at=from;
  for(;;){const candidate=join(at,'node_modules',name,'package.json');
   try{const actual=await realpath(candidate);contained(root,actual);return actual;}catch(error){if(error.code!=='ENOENT')throw error;}
   if(at===root)break;const next=dirname(at);if(next===at)break;if(next!==root)contained(root,next);at=next;
  }throw Error('Missing staged dependency: '+name);
 }
 async function visit(name,from,optional=false){
  let file;try{file=await locate(name,from);}catch(error){if(optional&&/Missing staged dependency/.test(error.message))return;throw error;}
  if(visited.has(file))return;visited.add(file);const pkg=JSON.parse(await readFile(file,'utf8'));
  for(const dep of Object.keys(pkg.dependencies??{}))await visit(dep,dirname(file),Object.hasOwn(pkg.optionalDependencies??{},dep));
  for(const dep of Object.keys(pkg.optionalDependencies??{}))if(!Object.hasOwn(pkg.dependencies??{},dep))await visit(dep,dirname(file),true);
 }
 for(const name of closure.packages)await visit(name,root);
 return {modules:closure.files.length,packages:visited.size};
}
