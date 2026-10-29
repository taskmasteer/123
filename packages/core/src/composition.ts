import {createHash} from 'node:crypto';
import {AppError,type ArtifactFile} from '../../contracts/src/model.js';
export function parseComposition(value:unknown):string[]{if(!Array.isArray(value)||value.length>128||value.some(v=>typeof v!=='string'||! /^[a-f0-9]{64}$/.test(v)))throw new AppError('INVALID_INPUT','Некорректный отпечаток композиции.');return value;}
/** A small similarity signal, not proof of visual uniqueness. No text or credentials leave the worker. */
export function compositionSignature(files:ArtifactFile[]):string[]{
 const tokens:string[]=[];for(const file of files){
  if(!['text/html','text/css'].includes(file.mediaType))continue;const source=Buffer.from(file.bytes).toString('utf8');
  if(file.mediaType==='text/html'){const tags=[...source.matchAll(/<([a-z][a-z0-9-]*)\b/gi)].slice(0,2048).map(m=>m[1]!.toLowerCase());for(let i=0;i<tags.length;i++)tokens.push('html:'+tags.slice(i,i+3).join('/'));}
  for(const m of source.matchAll(/([a-z-]{2,50})\s*:\s*([^;{}]{1,200})[;}]/gi)){tokens.push('css:'+m[1]!.toLowerCase()+':'+m[2]!.trim().toLowerCase().replace(/\s+/g,' '));if(tokens.length>=4096)break;}
  if(tokens.length>=4096)break;
 }
 return [...new Set(tokens.map(token=>createHash('sha256').update(token).digest('hex')))].sort().slice(0,128);
}
export function compareCompositions(signature:string[],peers:string[][]){
 parseComposition(signature);const a=new Set(signature),bounded=peers.slice(0,16).filter(p=>Array.isArray(p)&&p.length>0&&p.length<=128&&p.every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)));
 let score=0;for(const peer of bounded){const b=new Set(peer),shared=[...a].filter(v=>b.has(v)).length;score=Math.max(score,shared/Math.max(1,a.size+b.size-shared));}
 return {score,compared:bounded.length,repeated:score>=0.9};
}
