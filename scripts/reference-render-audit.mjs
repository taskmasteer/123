import './lib/browser-env.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {artifactMediaType} from '../dist/packages/core/src/artifacts.js';
import {validateMentionedLink} from '../dist/apps/worker/src/validation/mentioned-link.js';
import {referenceResponsiveCss} from './lib/reference-responsive.mjs';
const id=process.argv[2];if(!/^sf_reference_[a-f0-9]{32}$/.test(id??''))throw Error('Pass an isolated matrix run ID');
const responsive=process.argv.includes('--responsive'),suffix=responsive?'-responsive':'';
const data=resolve('.local-state',id),report=JSON.parse(await readFile(resolve(data,'report.json'),'utf8'));
let audit=[];if(!process.argv.includes('--refresh'))try{audit=JSON.parse(await readFile(resolve(data,'render-audit'+suffix+'.json'),'utf8'));}catch{}
const browser=await chromium.launch({headless:true});
try{for(const result of report.results){
 if(audit.some(r=>r.siteId===result.siteId)||result.state!=='completed')continue;
 const out=resolve(data,result.reference+'-'+result.siteId),files=await Promise.all(result.files.map(async f=>({path:f.path,mediaType:artifactMediaType(f.path),bytes:await readFile(resolve(out,f.path))})));
 const server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html',file=files.find(f=>f.path===path);res.writeHead(file?200:404,{'content-type':file?.mediaType??'text/plain'});res.end(file?.bytes??'Not found');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const context=await browser.newContext();const errors=[],blocked=[];
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blocked.push(route.request().url());return route.abort();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));const views=[];
 try{for(const width of [1440,390]){await page.setViewportSize({width,height:900});await page.goto(origin,{waitUntil:'load',timeout:30000});if(responsive)await page.addStyleTag({content:referenceResponsiveCss(files.filter(f=>f.mediaType==='text/css').map(f=>f.bytes.toString()).join('\n'))});await page.screenshot({path:resolve(out,'audit-'+width+suffix+'.png'),fullPage:true});views.push({width,...await page.evaluate(()=>({title:document.title,textLength:document.body.innerText.length,overflow:document.documentElement.scrollWidth>innerWidth+1,mentionedLinkVisible:Array.from(document.querySelectorAll('a')).some(a=>a.href==='https://www.example.com/guide'&&a.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})),overflowElements:[...document.body.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left < -1);}).slice(0,12).map(e=>({tag:e.tagName,class:e.className,width:e.getBoundingClientRect().width,text:e.textContent.slice(0,100)}))}))});}
 audit.push({siteId:result.siteId,reference:result.reference,views,errors,blocked:[...new Set(blocked)],mentionedSectionIssues:validateMentionedLink(files,{domain:'audit.example',mentionedUrl:'https://www.example.com/guide'})});
 }finally{await context.close();await new Promise(r=>server.close(r));}
 await writeFile(resolve(data,'render-audit'+suffix+'.json'),JSON.stringify(audit,null,2));console.log(JSON.stringify(audit.at(-1)));
}}finally{await browser.close();}
