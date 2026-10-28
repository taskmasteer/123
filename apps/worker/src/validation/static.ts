import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import type { ArtifactFile, ValidationReport } from '../../../../packages/contracts/src/model.js';
import { artifactPath, checkArtifacts } from '../../../../packages/core/src/artifacts.js';

export type Issue = ValidationReport['issues'][number];
type Node = DefaultTreeAdapterMap['node'];
import { localReference } from '../../../../packages/core/src/references.js';
export { localReference } from '../../../../packages/core/src/references.js';
function children(node: Node): Node[] {
  const childNodes = 'childNodes' in node ? node.childNodes : [];
  return 'content' in node ? [...childNodes, node.content] : childNodes;
}
class DocumentComplexity extends Error {}
function walk(node: Node, visit: (node: Node) => void) {
  const pending = [{ node, depth: 0 }]; let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++visited > 20_000 || current.depth > 256) throw new DocumentComplexity('Document exceeds 20,000 nodes or 256 nesting levels.');
    visit(current.node);
    const descendants = children(current.node);
    if (visited + pending.length + descendants.length > 20_000) throw new DocumentComplexity('Document exceeds 20,000 nodes or 256 nesting levels.');
    for (let index = descendants.length - 1; index >= 0; index--) pending.push({ node: descendants[index]!, depth: current.depth + 1 });
  }
}
export function validateStatic(files: ArtifactFile[]): ValidationReport {
  const issues: Issue[] = []; const add = (code: string, path: string, message: string) => issues.push({ code, path, message });
  try { checkArtifacts(files); } catch (error) { return { ok: false, issues: [{ code: 'artifact', message: String(error) }], screenshotIds: [] }; }
  const paths = new Set(files.map((file) => file.path)); const ids = new Map<string, Set<string>>();
  const references: { source: string; raw: string; anchor: boolean }[] = [];
  if (!paths.has('index.html')) add('entrypoint', 'index.html', 'A root index.html is required.');
  for (const file of files) {
    if (!/^(text\/|image\/svg)/.test(file.mediaType)) continue;
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); }
    catch { add('encoding', file.path, 'Text files must use UTF-8.'); continue; }
    if (/(?:sk-(?:proj-)?[a-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i.test(text)) add('secret', file.path, 'Possible credential or private key.');
    if (/lorem ipsum|your (?:company|brand) (?:name|here)|\b(?:TODO|TBD)\b|placeholder (?:text|content)/i.test(text)) add('placeholder', file.path, 'Obvious placeholder content.');
    if (file.mediaType === 'text/css') {
      for (const match of text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)|@import\s+["']([^"']+)["']/gi)) references.push({ source: file.path, raw: match[1] ?? match[2]!, anchor: false });
      continue;
    }
    if (file.mediaType !== 'text/html' && file.mediaType !== 'image/svg+xml') continue;
    try {
      const document = parse(text); const anchors = new Set<string>(); ids.set(file.path, anchors);
      walk(document, (node) => {
        if (!('tagName' in node)) return;
        const tag = node.tagName; const attrs = Object.fromEntries(node.attrs.map((attr) => [attr.name, attr.value]));
        if (attrs.id) anchors.add(attrs.id); if (tag === 'a' && attrs.name) anchors.add(attrs.name);
        if (['form', 'input', 'textarea', 'select'].includes(tag) || 'formaction' in attrs || 'form' in attrs) add('form', file.path, 'Forms and data-entry fields are forbidden.');
        if (['base', 'iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'foreignObject'].includes(tag) ||
            (tag === 'meta' && /refresh/i.test(attrs['http-equiv'] ?? ''))) add('active-content', file.path, 'Embedded documents, base URLs and refresh redirects are forbidden.');
        if (tag === 'script' && attrs.type && !/^(?:text|application)\/javascript$/i.test(attrs.type)) add('script-type', file.path, 'Only classic browser JavaScript is allowed.');
        if (file.mediaType === 'text/html' && tag === 'html' && !attrs.lang) add('readability', file.path, 'Set the document language.');
        for (const attribute of ['src', 'href', 'poster', 'xlink:href']) {
          if (attrs[attribute] === undefined) continue;
          const anchor = tag === 'a' && attribute === 'href';
          const raw = attrs[attribute]!;
          if (raw.startsWith('data:') && !anchor && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(raw)) continue;
          references.push({ source: file.path, raw, anchor });
        }
        if (attrs.srcset) {
          for (const candidate of attrs.srcset.split(',')) references.push({ source: file.path, raw: candidate.trim().split(/\s+/)[0]!, anchor: false });
        }
        if (attrs.style) {
          for (const match of attrs.style.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) references.push({ source: file.path, raw: match[1]!, anchor: false });
        }
      });
    } catch (error) {
      add(error instanceof DocumentComplexity ? 'document-complexity' : 'static-error', file.path,
        error instanceof DocumentComplexity ? error.message : 'Document parsing or analysis failed.');
    }
  }
  for (const reference of references) {
    try {
      const target = localReference(reference.source, reference.raw);
      if (!target) {
        if (!reference.anchor) add('external-request', reference.source, 'External resource requests are forbidden.');
      } else if (!paths.has(target.path) || (reference.anchor && target.fragment && !ids.get(target.path)?.has(target.fragment))) {
        add('broken-link', reference.source, 'Missing internal target: ' + reference.raw);
      }
    } catch { add(reference.anchor ? 'broken-link' : 'external-request', reference.source, 'Unsafe URL: ' + reference.raw); }
  }
  return { ok: issues.length === 0, issues, screenshotIds: [] };
}
