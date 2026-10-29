import {test,expect} from 'vitest';import {compositionSignature,compareCompositions} from '../src/composition.js';
test('measures repeated markup and style composition with bounded content-free signatures',()=>{
 const files=[{path:'index.html',mediaType:'text/html',bytes:Buffer.from('<main><h1>One topic</h1><section><p>Body</p></section></main>')},{path:'style.css',mediaType:'text/css',bytes:Buffer.from('main{display:grid;gap:24px}section{padding:20px}') }];
 const a=compositionSignature(files),b=compositionSignature(files.map(f=>({...f,bytes:Buffer.from(f.bytes.toString().replace('One topic','Other concept'))})));expect(a.length).toBeGreaterThan(0);expect(a.length).toBeLessThanOrEqual(128);expect(JSON.stringify(a)).not.toContain('topic');expect(compareCompositions(a,[b])).toEqual({score:1,compared:1,repeated:true});expect(compareCompositions(a,[]).score).toBe(0);
});
