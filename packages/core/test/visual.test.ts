import { expect, test } from 'vitest';
import { createEditableMap } from '../src/visual/editable-map.js';
import { patchFiles } from '../src/visual/html-patch.js';
import { patchStyles } from '../src/visual/css-patch.js';
import { projectSelection } from '../src/visual/projection.js';
const identity = { siteId: 'site', revisionId: 'revision', manifestId: 'manifest' };
const html = '<!doctype html>\r\n<html lang="en"><head></head><body><h1>Same 😀</h1><p>Same 😀</p><p>Mixed <em>child</em></p><a href="#x">Link</a><div id="x">Target</div></body></html>';
const files = [{ path: 'index.html', mediaType: 'text/html', bytes: new TextEncoder().encode(html) }];
test('text edits retain an unrelated UTF-8 BOM and every surrounding original byte',()=>{
 const source='<!doctype html><html lang="en"><head></head><body><h1>Old</h1></body></html>';
 const bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(source)]),input=[{path:'index.html',mediaType:'text/html',bytes}];
 const map=createEditableMap(input,identity),result=patchFiles(input,map,{elementId:map.elements.find(e=>e.tag==='h1')!.elementId,text:'New'});
 expect(Buffer.from(result[0]!.bytes)).toEqual(Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(source.replace('Old','New'))]));
});
test.each([
 `STYLE='--custom: "a&b"; display: grid;   '`,
 `StYlE = "--custom: &quot;a&amp;b&quot;; display: grid;\r\n  "`,
 `STYLE='--custom: &#34;a&#x26;b&#34;; color: blue; display: grid;   '`,
 `style=color:blue`,
 `STYLE`,
])('style patch preserves untouched lexical attribute bytes: %s',attribute=>{
 const source=`<!doctype html><html lang="en"><head></head><body><h1 ${attribute}>Old</h1></body></html>`,input=[{path:'index.html',mediaType:'text/html',bytes:Buffer.from(source)}];
 const map=createEditableMap(input,identity),target=map.elements.find(e=>e.tag==='h1')!;
 const expected=attribute==='STYLE'?'STYLE="color: red !important;"':attribute==='style=color:blue'?'style=color:&#32;red&#32;!important;':attribute.replace('color: blue;','').replace(/(display: grid;)/,'$1 color: red !important;');
 const result=patchFiles(input,map,{elementId:target.elementId,styles:{color:'red'}});
 expect(Buffer.from(result[0]!.bytes)).toEqual(Buffer.from(source.replace(attribute,expected)));
 const nextMap=createEditableMap(result,map.binding);expect(Buffer.from(patchFiles(result,nextMap,{elementId:target.elementId,styles:{color:'red'}})[0]!.bytes)).toEqual(Buffer.from(result[0]!.bytes));
});
test.each(['<img/>','<img />','<img src="old.png"/>','<img src="old.png" />'])('style insertion preserves valid self-closing image markup: %s',image=>{
 const source=`<!doctype html><html lang="en"><head></head><body>${image}</body></html>`,input=[{path:'index.html',mediaType:'text/html',bytes:Buffer.from(source)}],map=createEditableMap(input,identity),target=map.elements.find(e=>e.tag==='img')!;
 expect(target.fields).toContain('styles');const changed=patchFiles(input,map,{elementId:target.elementId,styles:{margin:'1px'}});
 const at=image.replace(/\s*\/>$/,'').length;
 expect(Buffer.from(changed[0]!.bytes)).toEqual(Buffer.from(source.replace(image,image.slice(0,at)+' style="margin: 1px !important;"'+image.slice(at))));
});
test('a slash in an unquoted img attribute remains part of that attribute during style insertion',()=>{
 const source='<!doctype html><html lang="en"><head></head><body><img src=old.png/></body></html>',input=[{path:'index.html',mediaType:'text/html',bytes:Buffer.from(source)}],map=createEditableMap(input,identity);
 const result=patchFiles(input,map,{elementId:map.elements.find(e=>e.tag==='img')!.elementId,styles:{margin:'1px'}});
 expect(Buffer.from(result[0]!.bytes)).toEqual(Buffer.from(source.replace('<img src=old.png/>','<img src=old.png/ style="margin: 1px !important;">')));
});
test('patches only the selected original span, escaping script text and preserving unrelated CRLF/non-BMP bytes', () => {
    const map = createEditableMap(files, identity), target = map.elements.find(e => e.tag === 'h1')!;
    const result = patchFiles(files, map, { elementId: target.elementId, text: '<script>alert("x")</script> & 😀' });
    expect(new TextDecoder().decode(result[0]!.bytes)).toBe(html.replace('Same 😀', '&lt;script&gt;alert("x")&lt;/script&gt; &amp; 😀'));
    expect(map.elements.find(e => e.tag === 'p' && !e.text)?.fields).not.toContain('text');
});
test('rejects unsafe links, stale maps and foreign IDs before changing bytes', () => {
    const map = createEditableMap(files, identity), a = map.elements.find(e => e.tag === 'a')!;
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'file:///x', 'https://user:pass@example.org', 'missing.html', '%252e%252e/x'])
        expect(() => patchFiles(files, map, { elementId: a.elementId, href })).toThrow();
    expect(() => patchFiles([{ ...files[0]!, bytes: new TextEncoder().encode(html + ' ') }], map, { elementId: a.elementId, href: '#x' })).toThrow();
    expect(() => patchFiles(files, map, { elementId: 'e_' + '0'.repeat(64), text: 'X' })).toThrow();
    expect(new TextDecoder().decode(patchFiles(files, map, { elementId: a.elementId, href: 'https://example.org/a' })[0]!.bytes)).toContain('href="https://example.org/a"');
});
test('CSS grammar is bounded, preserves unrelated declarations and beats existing important longhands without growing duplicates', () => {
    const source = 'display: grid; color:red !important; margin-left:2px!important; --untouched: "a;b";';
    const next = patchStyles(source, { color: '#123456', margin: '1px auto' });
    expect(next).toContain('display: grid;');
    expect(next).toContain('--untouched: "a;b";');
    expect(next).toContain('margin-left:2px!important;');
    expect(next).toContain('color: #123456 !important;');
    expect(next).toContain('margin: 1px auto !important;');
    expect(patchStyles(next, { color: '#123456', margin: '1px auto' })).toBe(next);
    for (const value of ['red;display:none', 'var(--x)', 'url(x)', 'rgb(999,0,0)', 'red!important'])
        expect(() => patchStyles('', { color: value })).toThrow();
    for (const value of ['-1px', '999px', 'calc(1px)', '1vw'])
        expect(() => patchStyles('', { padding: value })).toThrow();
});
test('selection projection strips all generated execution/navigation while retaining source selections and safe CSS', () => {
    const input = [{ ...files[0]!, bytes: new TextEncoder().encode('<!doctype html><html lang="en"><head><style>h1{color:blue}</style><script>parent.invoke()</script><meta http-equiv="refresh" content="0;url=https://trap.invalid"></head><body onload="fetch(1)"><h1 onclick="fetch(2)" data-sf-element="forged">Title</h1><a href="https://trap.invalid" target="_top">Go</a><template><img src="https://trap.invalid"><script>alert(1)</script></template><svg onload="alert(1)"></svg><iframe src="/api"></iframe></body></html>') }];
    const projection = projectSelection(input, createEditableMap(input, identity));
    const html = projection.documents[0]!.html;
    expect(html).toContain('color:blue');
    expect(html).toContain('data-sf-element="e_');
    for (const unsafe of ['<script', 'onload', 'onclick', 'forged', 'trap.invalid', '<svg', '<iframe', '<template', 'target=', 'href='])
        expect(html).not.toContain(unsafe);
    expect(new TextDecoder().decode(input[0]!.bytes)).toContain('parent.invoke()');
});
test('an authorized image replaces only the selected src and preserves original assets, attributes and other images', () => {
    const id = '11111111-1111-4111-8111-111111111111', source = '<!doctype html><html lang="en"><head></head><body><img src="old.png" alt="Keep alt" width="20"><img src="old.png" alt="Other"></body></html>';
    const input = [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from(source) }, { path: 'old.png', mediaType: 'image/png', bytes: Buffer.from('original bytes') }];
    const map = createEditableMap(input, identity), image = { path: `assets/visual-${id}.png`, mediaType: 'image/png', bytes: Buffer.from('verified by trusted asset lookup') };
    const output = patchFiles(input, map, { elementId: map.elements.find(e => e.tag === 'img')!.elementId, imageAssetId: id }, image);
    expect(new TextDecoder().decode(output[0]!.bytes)).toBe(source.replace('src="old.png"', `src="assets/visual-${id}.png"`));
    expect(output[1]).toEqual(input[1]);
    expect(output[2]).toEqual(image);
    expect(() => patchFiles(input, map, { elementId: map.elements[0]!.elementId, imageAssetId: id })).toThrow();
});
