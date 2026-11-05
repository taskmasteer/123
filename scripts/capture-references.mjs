import './lib/browser-env.mjs';
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {lookup} from 'node:dns/promises';
import {isPublicAddress} from '../dist/packages/adapters/src/public-address.js';
const root=resolve(import.meta.dirname,'..'),refs=JSON.parse(await readFile(resolve(root,'references/catalog.json'),'utf8')),styles=JSON.parse(await readFile(resolve(root,'templates/catalog.json'),'utf8'));
const browser=await chromium.launch({headless:true});const results=[];
try{for(const ref of refs){const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});try{
 const allowed=new Map();await context.route('**/*',async route=>{try{const u=new URL(route.request().url());if(!['http:','https:'].includes(u.protocol)||u.hostname==='esmartsoft.com'||u.hostname.endsWith('.esmartsoft.com'))return route.abort();if(!allowed.has(u.hostname))allowed.set(u.hostname,(await lookup(u.hostname,{all:true})).every(a=>isPublicAddress(a.address)));if(!allowed.get(u.hostname))return route.abort();await route.continue();}catch{await route.abort();}});
 const page=await context.newPage();const response=await page.goto(ref.url,{waitUntil:'domcontentloaded',timeout:25000});if(!response?.ok())throw Error('HTTP '+response?.status());await page.waitForTimeout(2500);
 await mkdir(resolve(root,'references/previews'),{recursive:true});await page.screenshot({path:resolve(root,'references/previews',ref.id+'.jpg'),type:'jpeg',quality:65});
 const body=await page.evaluate(()=>{
  const properties=['display','grid-template-columns','gap','flex-direction','flex-wrap','align-items','justify-content','padding','margin','max-width','min-height','background-color','color','font-size','font-weight','line-height','letter-spacing','text-align','border-radius','border','box-shadow'];let count=0,text=0;
  function clone(node){if(node.nodeType===3){if(!node.textContent.trim())return '';return 'Content '+(++text)+' ';}if(node.nodeType!==1||count++>1200)return '';const tag=node.tagName.toLowerCase(),css=getComputedStyle(node);if(['script','style','noscript','iframe','form','input','button','video','canvas','svg','link','meta'].includes(tag)||css.display==='none'||css.visibility==='hidden')return '';const out=document.createElement(['img','picture'].includes(tag)?'div':tag);out.className='ref-node';for(const prop of properties){const value=css.getPropertyValue(prop);if(value&&!value.includes('url('))out.style.setProperty(prop,value);}out.style.fontFamily='Arial, sans-serif';if(tag==='a')out.setAttribute('href','#content');if(tag==='img'){out.style.minHeight='160px';out.style.backgroundColor='#8882';}else for(const child of node.childNodes){const result=clone(child);if(typeof result==='string')out.append(document.createTextNode(result));else if(result)out.append(result);}return out;}
  return clone(document.body).outerHTML;
 });
 const id='reference-'+ref.id,dir=resolve(root,'templates',id);await mkdir(dir,{recursive:true});await writeFile(resolve(dir,'index.html'),'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Website</title><link rel="stylesheet" href="styles.css"></head>'+body+'</html>');await writeFile(resolve(dir,'styles.css'),'html{overflow-x:hidden}body{margin:0}*{box-sizing:border-box}img{max-width:100%}@media(max-width:700px){.ref-node{grid-template-columns:1fr!important;flex-wrap:wrap!important;max-width:100%!important;min-width:0!important}.ref-node h1{font-size:clamp(32px,8vw,64px)!important}}');
 if(!styles.some(s=>s.id===id))styles.push({id,name:ref.name+' · композиция',version:'1.0.0',enabled:true,referenceIds:[ref.id],files:['index.html','styles.css']});results.push({id:ref.id,ready:true});
 }catch(e){results.push({id:ref.id,ready:false,error:String(e.message).slice(0,150)});}finally{await context.close();}console.log(JSON.stringify(results.at(-1)));}
 await writeFile(resolve(root,'templates/catalog.json'),JSON.stringify(styles,null,2));await writeFile(resolve(root,'references/snapshots.json'),JSON.stringify(results,null,2));
}finally{await browser.close();}

await import('./compact-references.mjs');
