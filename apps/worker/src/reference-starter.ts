import type {ArtifactFile} from '../../../packages/contracts/src/model.js';

/** Captured references may contain hundreds of generated classes and anonymous text
 * slots. Carry their visual vocabulary into a new page without sending that DOM to the model. */
export function referenceStarter(files:ArtifactFile[]):ArtifactFile[] {
  const css=files.find(f=>f.path==='styles.css');
  const source=css ? Buffer.from(css.bytes).toString('utf8') : '';
  const palette=new Map<string,number>(),families=new Set<string>(),sizes=new Set<number>();
  for(const match of source.matchAll(/(?:^|[;{])\s*(color|background-color|font-size|font-family):\s*([^;{}]+)/gi)){
    const property=match[1]!.toLowerCase(),value=match[2]!.trim();
    if(property==='font-family' && /^[\w ,'"-]{1,100}$/.test(value))families.add(value);
    if(property==='font-size' && /^\d+(?:\.\d+)?px$/.test(value))sizes.add(parseFloat(value));
    if((property==='color'||property==='background-color') && /^(?:#[a-f0-9]{3,8}|rgb\([\d., %]+\))$/i.test(value))palette.set(value,(palette.get(value)??0)+1);
  }
  const colors=[...palette].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([value])=>value);
  const cssText=`/* Visual samples from the selected reference:
Palette: ${colors.join('; ')}
Type families: ${[...families].slice(0,6).join('; ')}
Type scale in pixels: ${[...sizes].sort((a,b)=>a-b).slice(-12).join(', ')}
Build a responsive composition for the editorial plan. */
*{box-sizing:border-box}body{margin:0;font:1rem/1.55 system-ui,sans-serif}main{max-width:76rem;margin:auto;padding:clamp(1rem,4vw,4rem)}`;
  const htmlText='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title></title><link rel="stylesheet" href="styles.css"></head><body><main><h1 data-topic></h1></main></body></html>';
  // The publisher's own assets are attached separately after template preparation.
  return [
    {path:'index.html',mediaType:'text/html',bytes:Buffer.from(htmlText)},
    {path:'styles.css',mediaType:'text/css',bytes:Buffer.from(cssText)},
  ];
}
