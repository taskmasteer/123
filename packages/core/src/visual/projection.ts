import type { ArtifactFile } from '../../../contracts/src/model.js';
import type { Projection } from '../../../contracts/src/visual.js';
import type { EditableMap } from './editable-map.js';
import { parse, serialize, defaultTreeAdapter } from 'parse5';
import * as css from 'css-tree';
import type { HtmlNode, HtmlElement } from './editable-map.js';
import { localReference } from '../references.js';
import { AppError } from '../../../contracts/src/model.js';
import { mapBinding } from '../../../contracts/src/visual.js';
import { parseSrcset, stringifySrcset } from 'srcset';
const allowed = new Set('html head body title style h1 h2 h3 h4 h5 h6 p a span strong em b i small ul ol li dl dt dd figure figcaption blockquote cite q abbr address div section article header footer nav main aside img br hr table caption colgroup col thead tbody tfoot tr th td pre code time mark s u sup sub details summary'.split(' '));
const attributes = new Set('id class lang dir role title alt width height colspan rowspan scope aria-label aria-hidden aria-labelledby aria-describedby'.split(' '));
const bad = (message = 'Неподдерживаемый ресурс режима выделения.'): never => { throw new AppError('INVALID_INPUT', message); };
function embedded(raw: string): string {
    const match = /^data:(image\/(?:png|jpeg|gif|webp)|font\/(?:woff|woff2));base64,([A-Za-z0-9+/=]+)$/.exec(raw);
    if (!match || raw.length > 2800000)
        return bad();
    const bytes = Buffer.from(match[2]!, 'base64');
    if (bytes.toString('base64') !== match[2] || bytes.length > 2000000)
        return bad();
    const mime = match[1]!;
    const valid = mime === 'image/png' ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 : mime === 'image/gif' ? /^GIF8[79]a/.test(bytes.subarray(0, 6).toString()) : mime === 'image/webp' ? bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' : bytes.subarray(0, 4).toString() === (mime === 'font/woff' ? 'wOFF' : 'wOF2');
    return valid ? raw : bad();
}
function sanitize(source: string, path: string, resource: (raw: string, path: string) => string, stylesheet: (text: string, path: string) => string, elementAt: (offset: number) => string | undefined): string {
    const document = parse(source, { sourceCodeLocationInfo: true });
    let count = 0;
    function visit(node: HtmlNode, depth: number) {
        if (++count > 20000 || depth > 256)
            return bad('Слишком сложная проекция.');
        if ('childNodes' in node) {
            const clean: HtmlNode[] = [];
            for (const child of node.childNodes) {
                if ('tagName' in child) {
                    if (child.tagName === 'link' && child.attrs.some(a => a.name === 'rel' && a.value.toLowerCase() === 'stylesheet')) {
                        const href = child.attrs.find(a => a.name === 'href')?.value;
                        if (href) {
                            const style = defaultTreeAdapter.createElement('style', child.namespaceURI, []);
                            defaultTreeAdapter.insertText(style, stylesheet('@import ' + JSON.stringify(href) + ';', path).replace(/</g, '\\3c '));
                            clean.push(style);
                        }
                        continue;
                    }
                    if (child.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !allowed.has(child.tagName)) {
                        if (child.tagName === 'svg') {
                            const placeholder = defaultTreeAdapter.createElement('span', node.nodeName === '#document' ? 'http://www.w3.org/1999/xhtml' as HtmlElement['namespaceURI'] : (node as HtmlElement).namespaceURI, []);
                            defaultTreeAdapter.insertText(placeholder, 'SVG недоступен в режиме выделения');
                            clean.push(placeholder);
                        }
                        continue;
                    }
                    const attrs = child.attrs;
                    child.attrs = attrs.filter(a => attributes.has(a.name));
                    const id = elementAt(child.sourceCodeLocation?.startOffset ?? -1);
                    if (id)
                        child.attrs.push({ name: 'data-sf-element', value: id });
                    const inline = attrs.find(a => a.name === 'style');
                    if (inline)
                        child.attrs.push({ name: 'style', value: stylesheet(inline.value, path) });
                    if (child.tagName === 'img') {
                        const src = attrs.find(a => a.name === 'src')?.value;
                        if (src) {
                            try {
                                child.attrs.push({ name: 'src', value: resource(src, path) });
                            }
                            catch {
                                child.attrs.push({ name: 'alt', value: 'Изображение недоступно в режиме выделения' });
                            }
                        }
                    }
                    if (child.tagName === 'img') {
                        const srcset = attrs.find(a => a.name === 'srcset')?.value;
                        if (srcset) {
                            try {
                                const items = parseSrcset(srcset, { strict: true });
                                if (items.length > 16)
                                    return bad();
                                child.attrs.push({ name: 'srcset', value: stringifySrcset(items.map(item => ({ ...item, url: resource(item.url, path) })), { strict: true }) });
                            }
                            catch {
                                child.attrs = child.attrs.filter(a => a.name !== 'alt');
                                child.attrs.push({ name: 'alt', value: 'Адаптивное изображение недоступно в режиме выделения' });
                            }
                        }
                    }
                    if (child.tagName === 'style') {
                        const text = child.childNodes.filter(c => 'value' in c).map(c => (c as {
                            value: string;
                        }).value).join('');
                        child.childNodes = [];
                        defaultTreeAdapter.insertText(child, stylesheet(text, path).replace(/</g, '\\3c '));
                    }
                }
                if (child.nodeName !== '#comment') {
                    clean.push(child);
                    if (!('tagName' in child) || child.tagName !== 'style')
                        visit(child, depth + 1);
                }
            }
            node.childNodes = clean as typeof node.childNodes;
        }
    }
    visit(document, 0);
    return serialize(document);
}
function cssProjection(text: string, path: string, resource: (raw: string, path: string) => string, load?: (raw: string, path: string) => {
    text: string;
    path: string;
}, seen = new Set<string>(), declarations = false): string {
    const ast = css.parse(text, { context: declarations ? 'declarationList' : 'stylesheet', parseCustomProperty: true, onParseError: () => bad('Неподдерживаемый CSS режима выделения.') });
    let count = 0;
    css.walk(ast, function (node, item, list) {
        if (++count > 20000 || node.type === 'Raw')
            return bad('Неподдерживаемый CSS режима выделения.');
        if (node.type === 'Atrule' && node.name.toLowerCase() === 'import') {
            if (!load || !list || !item || !node.prelude || node.prelude.type !== 'AtrulePrelude')
                return bad();
            const parts = node.prelude.children.toArray();
            const first = parts[0];
            if (parts.length !== 1 || !first || (first.type !== 'String' && first.type !== 'Url'))
                return bad();
            const imported = load(first.value, path);
            if (seen.has(imported.path) || seen.size >= 100)
                return bad('Циклический импорт CSS.');
            const next = new Set(seen).add(imported.path);
            const parsed = css.parse(cssProjection(imported.text, imported.path, resource, load, next), { context: 'stylesheet' });
            if (parsed.type !== 'StyleSheet')
                return bad();
            list.replace(item, parsed.children);
            return css.walk.skip;
        }
        if (node.type === 'Url')
            node.value = resource(node.value, path);
        if (node.type === 'Declaration' && /^(?:behavior|-moz-binding)$/i.test(node.property))
            return bad();
        if (node.type === 'Function' && /^(?:expression|paint)$/i.test(node.name))
            return bad();
    });
    return css.generate(ast);
}
export function projectSelection(files: ArtifactFile[], map: EditableMap): Projection {
    let expandedBytes = 0, documentBytes = 0;
    const charge = (size: number) => {
        expandedBytes += size;
        if (expandedBytes > 10000000)
            return bad('Ресурсы проекции превышают лимит.');
    };
    const byPath = new Map(files.map(f => [f.path, f]));
    function resolve(raw: string, path: string) {
        const reference = localReference(path, raw);
        const file = reference ? byPath.get(reference.path) : undefined;
        if (!file)
            return bad();
        return file;
    }
    function resource(raw: string, path: string): string {
        if (raw.startsWith('data:')) {
            charge(Buffer.byteLength(raw));
            return embedded(raw);
        }
        const file = resolve(raw, path);
        charge(Math.ceil(file.bytes.length * 4 / 3) + 100);
        return embedded(`data:${file.mediaType};base64,${Buffer.from(file.bytes).toString('base64')}`);
    }
    const load = (raw: string, path: string) => {
        const f = resolve(raw, path);
        if (f.mediaType !== 'text/css')
            return bad();
        charge(f.bytes.length);
        return { path: f.path, text: new TextDecoder('utf-8', { fatal: true }).decode(f.bytes) };
    };
    const documents = [...map.sources].map(([path, source]) => {
        const offsets = new Map(map.elements.filter(e => e.documentPath === path).map(e => [map.nodes.get(e.elementId)!.sourceCodeLocation!.startOffset, e.elementId]));
        const html = sanitize(source, path, resource, (text, p) => cssProjection(text, p, resource, load, new Set(), !/^\s*@import\b/.test(text) && !text.includes('{')), offset => offsets.get(offset));
        documentBytes += Buffer.byteLength(html);
        if (documentBytes > 12000000)
            return bad('Проекция превышает лимит.');
        return { path, html };
    });
    const result: Projection = { version: 1, binding: map.binding, elements: map.elements, documents };
    if (Buffer.byteLength(JSON.stringify(result)) > 12000000)
        return bad('Проекция превышает лимит.');
    return result;
}
/** Unenrolled local renderer receives only this projection, never original archives or authentication. */
export function verifiedProjection(value: unknown): Projection {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return bad();
    const p = value as Projection;
    if (Object.keys(p).sort().join(',') !== 'binding,documents,elements,version' || p.version !== 1 || !Array.isArray(p.elements) || p.elements.length > 20000 || !Array.isArray(p.documents) || !p.documents.length || p.documents.length > 100 || Buffer.byteLength(JSON.stringify(p)) > 12000000)
        return bad();
    mapBinding(p.binding);
    const ids = new Set<string>();
    for (const e of p.elements) {
        if (!e || typeof e.elementId !== 'string' || !/^e_[a-f0-9]{64}$/.test(e.elementId) || ids.has(e.elementId) || typeof e.documentPath !== 'string' || typeof e.tag !== 'string' || !Array.isArray(e.fields) || e.fields.some(k => !['styles', 'text', 'href', 'imageAssetId'].includes(k)))
            return bad();
        ids.add(e.elementId);
    }
    return { ...p, documents: p.documents.map(d => {
            if (!d || typeof d.path !== 'string' || typeof d.html !== 'string' || d.html.length > 12000000)
                return bad();
            // Positions are reconstructed from this immutable disposable input; IDs alone never authorize saving.
            const offsets = new Map<number, string>();
            const pending = [parse(d.html, { sourceCodeLocationInfo: true })] as HtmlNode[];
            while (pending.length) {
                const n = pending.pop()!;
                if ('attrs' in n) {
                    const id = n.attrs.find(a => a.name === 'data-sf-element')?.value;
                    if (id && ids.has(id) && p.elements.some(e => e.elementId === id && e.documentPath === d.path))
                        offsets.set(n.sourceCodeLocation!.startOffset, id);
                }
                if ('childNodes' in n)
                    pending.push(...n.childNodes);
            }
            return { path: d.path, html: sanitize(d.html, d.path, raw => embedded(raw), (text, path) => cssProjection(text, path, raw => embedded(raw), undefined, new Set(), !text.includes('{')), offset => offsets.get(offset)) };
        }) };
}
