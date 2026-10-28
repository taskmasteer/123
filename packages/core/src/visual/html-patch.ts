import type { ArtifactFile } from '../../../contracts/src/model.js';
import type { ElementPatch } from '../../../contracts/src/visual.js';
import type { EditableMap } from './editable-map.js';
import { digest, createEditableMap } from './editable-map.js';
import { elementPatch } from '../../../contracts/src/visual.js';
import { AppError } from '../../../contracts/src/model.js';
import { patchStyles,styleEdits } from './css-patch.js';
import {attributeSpan} from './attribute-spans.js';
import { localReference } from '../references.js';
import { parse } from 'parse5';
export const escapeText = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escapeAttribute = (v: string) => escapeText(v).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export function patchFiles(files: ArtifactFile[], map: EditableMap, input: ElementPatch, image?: ArtifactFile): ArtifactFile[] {
    const patch = elementPatch(input), bad = (message: string): never => { throw new AppError('INVALID_INPUT', message); };
    if (files.length !== map.hashes.size || files.some(f => map.hashes.get(f.path) !== digest(f.bytes)))
        return bad('Карта исходника устарела.');
    const e = map.elements.find(e => e.elementId === patch.elementId), node = map.nodes.get(patch.elementId);
    if (!e || !node?.sourceCodeLocation)
        return bad('Элемент недоступен.');
    for (const key of Object.keys(patch).filter(k => k !== 'elementId'))
        if (!e.fields.includes(key))
            return bad('Эта правка не поддерживается для элемента.');
    const source = map.sources.get(e.documentPath)!, loc = node.sourceCodeLocation;
    const spans: {
        start: number;
        end: number;
        value: string;
    }[] = [];
    function attribute(name: string, value: string) {
        const range = loc!.attrs?.[name];
        if (range){const lexical=attributeSpan(source,range.startOffset,range.endOffset);spans.push({start:lexical.start,end:lexical.end,value:lexical.encode(value)});}
        else if (name === 'style'){
            let at=loc!.startTag!.endOffset-1;const slashInValue=Object.values(loc!.attrs??{}).some(range=>range.startOffset<=at-1&&range.endOffset>at-1);if(source[at-1]==='/'&&!slashInValue)at--;while(/[\t\n\f\r ]/.test(source[at-1]??''))at--;
            spans.push({ start:at,end:at,value:` style="${escapeAttribute(value)}"` });
        }
        else
            return bad('У атрибута нет однозначного исходного диапазона.');
    }
    if (patch.text !== undefined) {
        const text = node.childNodes[0]?.sourceCodeLocation;
        if (!text)
            return bad('У текста нет исходного диапазона.');
        spans.push({ start: text.startOffset, end: text.endOffset, value: escapeText(patch.text) });
    }
    if (patch.href !== undefined) {
        const href = patch.href;
        if (!href || /[\u0000-\u0020\u007f\\]/.test(href) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|25)/i.test(href))
            return bad('Недопустимая ссылка.');
        if (/^(?:https?:)?\/\//i.test(href)) {
            const url = new URL(href.startsWith('//') ? 'https:' + href : href);
            if (!url.hostname || url.username || url.password)
                return bad('Недопустимая внешняя ссылка.');
        }
        const ref = localReference(e.documentPath, href);
        if (ref) {
            const target = files.find(f => f.path === ref.path);
            if (!target)
                return bad('Внутренняя ссылка не найдена.');
            if (ref.fragment) {
                let found = false;
                const pending = [parse(new TextDecoder().decode(target.bytes))] as import('./editable-map.js').HtmlNode[];
                while (pending.length) {
                    const n = pending.pop()!;
                    if ('attrs' in n && n.attrs.some(a => (a.name === 'id' || (n.tagName === 'a' && a.name === 'name')) && a.value === ref.fragment))
                        found = true;
                    if ('childNodes' in n)
                        pending.push(...n.childNodes);
                }
                if (!found)
                    return bad('Якорь не найден.');
            }
        }
        attribute('href', href);
    }
    const extra: ArtifactFile[] = [];
    if (patch.imageAssetId !== undefined) {
        const expected = `assets/visual-${patch.imageAssetId}.png`;
        if (!image || image.path !== expected || image.mediaType !== 'image/png')
            return bad('Проверенное изображение недоступно.');
        const old = files.find(f => f.path === expected);
        if (old && digest(old.bytes) !== digest(image.bytes))
            return bad('Путь изображения уже занят.');
        if (!old)
            extra.push(image);
        attribute('src', '../'.repeat(e.documentPath.split('/').length - 1) + expected);
    }
    if (patch.styles){
        const range=loc.attrs?.style;
        if(!range)attribute('style',patchStyles('',patch.styles));
        else {const lexical=attributeSpan(source,range.startOffset,range.endOffset);if(lexical.decoded!==node.attrs.find(a=>a.name==='style')?.value)return bad('Неоднозначное значение CSS.');
            for(const edit of styleEdits(lexical.decoded,patch.styles))spans.push({start:lexical.offset(edit.start),end:lexical.offset(edit.end),value:lexical.encode(edit.value)});
        }
    }
    let next = source;
    let last = source.length + 1;
    for (const span of spans.sort((a, b) => b.start - a.start)) {
        if (span.end > last)
            return bad('Перекрывающиеся правки.');
        last = span.start;
        next = next.slice(0, span.start) + span.value + next.slice(span.end);
    }
    const output = [...files.map(f => f.path === e.documentPath ? { ...f, bytes: Buffer.concat([f.bytes[0]===0xef&&f.bytes[1]===0xbb&&f.bytes[2]===0xbf?f.bytes.subarray(0,3):new Uint8Array(),new TextEncoder().encode(next)]) } : f), ...extra];
    const rebuilt = createEditableMap(output, map.binding);
    if (!rebuilt.nodes.has(e.elementId))
        return bad('Правка изменила структуру.');
    return output;
}
