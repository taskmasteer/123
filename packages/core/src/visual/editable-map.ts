import type { ArtifactFile } from '../../../contracts/src/model.js';
import type { MapBinding, EditableElement } from '../../../contracts/src/visual.js';
import { createHash } from 'node:crypto';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { AppError } from '../../../contracts/src/model.js';
import { checkArtifacts } from '../artifacts.js';
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export type HtmlNode = DefaultTreeAdapterMap['node'];
export type HtmlElement = DefaultTreeAdapterMap['element'];
export interface EditableMap {
    binding: MapBinding;
    elements: EditableElement[];
    nodes: Map<string, HtmlElement>;
    sources: Map<string, string>;
    hashes: Map<string, string>;
}
export const contentTags = new Set('h1 h2 h3 h4 h5 h6 p a span strong em b i small li dt dd figcaption blockquote cite q abbr address div section article header footer nav main aside'.split(' '));
export function createEditableMap(files: ArtifactFile[], identity: Omit<MapBinding, 'version' | 'mapId' | 'lineage'> & {
    lineage?: string;
}): EditableMap {
    checkArtifacts(files);
    const sources = new Map<string, string>(), hashes = new Map(files.map(f => [f.path, digest(f.bytes)]));
    const lineage = identity.lineage ?? digest(JSON.stringify([identity.siteId, identity.revisionId, identity.manifestId]));
    const binding: MapBinding = { ...identity, lineage, version: 1, mapId: digest(JSON.stringify([identity.siteId, identity.revisionId, identity.manifestId, lineage, [...hashes]])) };
    const map: EditableMap = { binding, elements: [], nodes: new Map(), sources, hashes };
    for (const file of files.filter(f => f.mediaType === 'text/html')) {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
        sources.set(file.path, source);
        const errors: string[] = [];
        const doc = parse(source, { sourceCodeLocationInfo: true, onParseError: e => {
                if (e.code !== 'missing-doctype')
                    errors.push(e.code);
            } });
        if (errors.length)
            continue;
        let count = 0;
        function visit(node: HtmlNode, path: string, depth: number, safe: boolean, body: boolean) {
            if (++count > 20000 || depth > 256)
                throw new AppError('INVALID_INPUT', 'Слишком сложный HTML.');
            if ('tagName' in node) {
                const loc = node.sourceCodeLocation;
                body = body || node.tagName === 'body';
                safe = safe && node.namespaceURI === 'http://www.w3.org/1999/xhtml' && !['script', 'style', 'template', 'svg', 'math', 'form', 'input', 'select', 'textarea', 'iframe', 'object', 'embed', 'head'].includes(node.tagName) && !!loc?.startTag && (!!loc.endTag || ['img', 'br', 'hr', 'meta', 'link'].includes(node.tagName));
                if (node.tagName === 'head')
                    safe = false;
                if (safe && body && (contentTags.has(node.tagName) || node.tagName === 'img') && !node.attrs.some(a => a.name === 'hidden' || a.name === 'contenteditable') && new Set(node.attrs.map(a => a.name)).size === node.attrs.length) {
                    const elementId = 'e_' + digest(JSON.stringify([lineage, file.path, path, node.tagName]));
                    const attrs = Object.fromEntries(node.attrs.map(a => [a.name, a.value]));
                    const fields = ['styles'];
                    const text = node.childNodes.length === 1 && node.childNodes[0]!.nodeName === '#text' && 'value' in node.childNodes[0]! ? node.childNodes[0].value : undefined;
                    if (text !== undefined && text.length <= 8000 && contentTags.has(node.tagName))
                        fields.push('text');
                    if (node.tagName === 'a' && attrs.href !== undefined)
                        fields.push('href');
                    if (node.tagName === 'img' && attrs.src !== undefined && attrs.srcset === undefined && (!node.parentNode || !('tagName' in node.parentNode) || node.parentNode.tagName !== 'picture'))
                        fields.push('imageAssetId');
                    map.elements.push({ elementId, documentPath: file.path, tag: node.tagName, fields, ...(text !== undefined && text.length <= 8000 ? { text } : {}), ...(fields.includes('href') ? { href: attrs.href! } : {}) });
                    map.nodes.set(elementId, node);
                }
            }
            if ('childNodes' in node)
                node.childNodes.forEach((child, i) => visit(child, path + '.' + i, depth + 1, safe, body));
        }
        // html/body can be implicit in otherwise valid documents, but no implicit target ancestry is editable.
        visit(doc, '0', 0, true, false);
    }
    return map;
}
