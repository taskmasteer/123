import type { ElementPatch } from '../../../contracts/src/visual.js';
import * as css from 'css-tree';
import { AppError } from '../../../contracts/src/model.js';
const names = { color: 'color', backgroundColor: 'background-color', fontSize: 'font-size', margin: 'margin', padding: 'padding' };
function validColor(v: string) {
    if (/^#[a-f0-9]{3}(?:[a-f0-9]|[a-f0-9]{3}|[a-f0-9]{5})?$/i.test(v) || /^(?:transparent|currentcolor|black|silver|gray|white|maroon|red|purple|fuchsia|green|lime|olive|yellow|navy|blue|teal|aqua)$/i.test(v))
        return true;
    const m = /^(rgb|rgba)\(([^)]+)\)$/i.exec(v);
    if (!m)
        return false;
    const p = m[2]!.split(',').map(x => x.trim());
    return p.length === (m[1]!.toLowerCase() === 'rgb' ? 3 : 4) && p.slice(0, 3).every(x => /^\d{1,3}$/.test(x) && Number(x) <= 255) && (p.length === 3 || /^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?|\.\d{1,3})$/.test(p[3]!));
}
export function validStyle(key: string, value: string) {
    if (!Object.hasOwn(names, key) || value.length > 128 || /[;!\\/]|[\u0000-\u001f]/.test(value))
        return false;
    if (key === 'color' || key === 'backgroundColor')
        return validColor(value);
    const tokens = value.trim().split(/\s+/);
    if (tokens.length > (key === 'fontSize' ? 1 : 4))
        return false;
    return tokens.every(v => {
        if (v === '0')
            return true;
        if (key === 'margin' && v === 'auto')
            return true;
        const m = /^(-?(?:\d+(?:\.\d{1,3})?|\.\d{1,3}))(px|rem|em|%)$/.exec(v);
        if (!m)
            return false;
        const n = Number(m[1]), abs = Math.abs(n);
        if (!Number.isFinite(n) || (key !== 'margin' && n < 0))
            return false;
        if (key === 'fontSize')
            return m[2] === 'px' ? n >= 1 && n <= 256 : m[2] === '%' ? n >= 10 && n <= 1000 : n >= .1 && n <= 16;
        return abs <= (m[2] === 'px' ? 512 : m[2] === '%' ? 100 : 32);
    });
}
export function patchStyles(source: string, styles: NonNullable<ElementPatch['styles']>): string {
    const bad = () => { throw new AppError('INVALID_INPUT', 'Недопустимое значение CSS.'); };
    const entries = Object.entries(styles);
    if (!entries.length || entries.some(([k, v]) => typeof v !== 'string' || !validStyle(k, v)))
        return bad();
    const ast = css.parse(source, { context: 'declarationList', positions: true, parseCustomProperty: true, onParseError: bad });
    const removes: {
        start: number;
        end: number;
    }[] = [];
    const touched = new Set(entries.map(([k]) => names[k as keyof typeof names]));
    ast.type === 'DeclarationList' && ast.children.forEach(node => {
        if (node.type !== 'Declaration' || !node.loc)
            return bad();
        if (touched.has(node.property.toLowerCase())) {
            let end = node.loc.end.offset;
            if (source[end] === ';')
                end++;
            removes.push({ start: node.loc.start.offset, end });
        }
    });
    let next = source;
    for (const span of removes.sort((a, b) => b.start - a.start))
        next = next.slice(0, span.start) + next.slice(span.end);
    next = next.trimEnd();
    if (next && !next.endsWith(';'))
        next += ';';
    return next + (next ? ' ' : '') + entries.map(([key, value]) => `${names[key as keyof typeof names]}: ${value.trim()} !important;`).join(' ');
}
