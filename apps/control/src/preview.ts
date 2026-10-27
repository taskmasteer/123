import {parse,serialize} from 'parse5';
import type {DefaultTreeAdapterMap} from 'parse5';
import * as css from 'css-tree';
import {parseSrcset,stringifySrcset} from 'srcset';
import {SignJWT} from 'jose';
import {AppError} from '../../../packages/contracts/src/model.js';
import type {ArtifactFile} from '../../../packages/contracts/src/model.js';
import {artifactPath} from '../../../packages/core/src/artifacts.js';
type Scope={userId:string;siteId:string;revisionId:string;expiresAt:number};
/** A response-only projection. Never save it to the archive or publish these capability URLs. */
export async function projectPreview(file:ArtifactFile,files:ArtifactFile[],scope:Scope,key:Uint8Array):Promise<Uint8Array>{
 if(!['text/html','text/css'].includes(file.mediaType))return file.bytes;
 const names=new Set(files.map(f=>f.path)),cache=new Map<string,string>();
 async function reference(raw:string,source=file.path):Promise<string>{
  if(!raw||raw.startsWith('#')||/^(?:https?:|mailto:|tel:|data:|\/\/)/i.test(raw))return raw;
  if(/[\\\u0000-\u0020]/.test(raw)||/%(?:2e|2f|5c|25|00)/i.test(raw))throw new AppError('INVALID_INPUT','Недопустимый путь предпросмотра.');
  const resolved=new URL(raw,'https://snapshot.invalid/'+source);if(resolved.origin!=='https://snapshot.invalid')throw new AppError('INVALID_INPUT','Недопустимая схема предпросмотра.');
  let depth=raw.startsWith('/')?0:source.split('/').length-1;for(const part of raw.split(/[?#]/)[0]!.split('/')){if(part==='..'){if(--depth<0)throw new AppError('INVALID_INPUT','Путь вне снимка.');}else if(part&&part!=='.')depth++;}
  let path=decodeURIComponent(resolved.pathname.slice(1));if(!path||path.endsWith('/'))path+='index.html';artifactPath(path);if(!names.has(path))throw new AppError('NOT_FOUND','Ресурс предпросмотра не найден.');
  let token=cache.get(path);if(!token){token=await new SignJWT({siteId:scope.siteId,revisionId:scope.revisionId,path}).setSubject(scope.userId).setAudience('site-preview-asset').setExpirationTime(scope.expiresAt).setProtectedHeader({alg:'HS256'}).sign(key);cache.set(path,token);}
  resolved.searchParams.delete('cap');resolved.searchParams.set('asset',token);return `/preview/${scope.siteId}/${scope.revisionId}/${path}${resolved.search}${resolved.hash}`;
 }
 async function stylesheet(text:string,context:'stylesheet'|'declarationList'='stylesheet'){
  const ast=css.parse(text,{context,parseCustomProperty:true,onParseError:()=>{throw new AppError('INVALID_INPUT','Неподдерживаемый CSS предпросмотра.');}});const edits:Promise<void>[]=[];let visited=0;
  css.walk(ast,function(node){if(++visited>20000)throw new AppError('INVALID_INPUT','CSS предпросмотра слишком сложный.');if(node.type==='Url')edits.push(reference(node.value).then(url=>{node.value=url;}));if(node.type==='Atrule'&&node.name.toLowerCase()==='import'&&node.prelude?.type==='AtrulePrelude'){const first=node.prelude.children.first;if(first?.type==='String')edits.push(reference(first.value).then(url=>{first.value=url;}));}});
  await Promise.all(edits);return css.generate(ast);
 }
 const text=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);
 if(file.mediaType==='text/css')return Buffer.from(await stylesheet(text));
 const document=parse(text),pending:DefaultTreeAdapterMap['node'][]=[document];let count=0;
 while(pending.length){const node=pending.pop()!;if(++count>20000)throw new AppError('INVALID_INPUT','Предпросмотр слишком сложный.');if('childNodes'in node)pending.push(...node.childNodes);if('content'in node)pending.push(node.content);
  if(!('tagName'in node))continue;
  for(const attribute of node.attrs){if(['src','href','poster','xlink:href'].includes(attribute.name))attribute.value=await reference(attribute.value);else if(attribute.name==='srcset')attribute.value=stringifySrcset(await Promise.all(parseSrcset(attribute.value,{strict:true}).map(async item=>({...item,url:await reference(item.url)}))),{strict:true});else if(attribute.name==='style')attribute.value=await stylesheet(attribute.value,'declarationList');}
  if(node.tagName==='style')for(const child of node.childNodes)if(child.nodeName==='#text'&&'value'in child)child.value=await stylesheet(child.value);
 }
 return Buffer.from(serialize(document));
}
