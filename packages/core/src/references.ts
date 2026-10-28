import { artifactPath } from './artifacts.js';
const internalOrigin = 'https://artifact.invalid/';
export interface Reference {
    path: string;
    fragment: string;
}
/** Resolve URL references as browsers do, rejecting encoded separators/traversal first.
 * Ordinary ../ references are allowed only when the final target stays in the site.
 */
export function localReference(source: string, raw: string): Reference | null {
    if (/^(mailto:|tel:)/i.test(raw))
        return null;
    if (/^(https?:)?\/\//i.test(raw))
        return null;
    if (/[\\\x00-\x20]/.test(raw) || /%(?:2e|2f|5c|25|00)/i.test(raw))
        throw new Error('Unsafe encoded or ambiguous path.');
    const url = new URL(raw, internalOrigin + source);
    if (url.origin !== new URL(internalOrigin).origin)
        throw new Error('Unsupported URL scheme.');
    // URL normalization would otherwise turn ../../x into /x, hiding the escape.
    let depth = source.split('/').length - 1;
    if (raw.startsWith('/'))
        depth = 0;
    for (const segment of raw.split(/[?#]/)[0]!.split('/')) {
        if (segment === '..') {
            if (--depth < 0)
                throw new Error('Path escapes site root.');
        }
        else if (segment && segment !== '.')
            depth++;
    }
    let path = decodeURIComponent(url.pathname.slice(1));
    if (!path || path.endsWith('/'))
        path += 'index.html';
    artifactPath(path);
    return { path, fragment: decodeURIComponent(url.hash.slice(1)) };
}
