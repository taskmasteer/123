import './lib/browser-env.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {referenceResponsiveCss} from './lib/reference-responsive.mjs';
const catalog=JSON.parse(await readFile('templates/catalog.json','utf8'));
const browser=await chromium.launch({headless:true}),page=await browser.newPage();
await page.route('**/*',r=>r.abort());
const results=[];
const geometry=()=>[...document.querySelectorAll('.ref-node')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height];});
try{for(const ref of catalog.filter(t=>t.enabled&&t.id.startsWith('reference-'))){
 const root='templates/'+ref.id,html=await readFile(root+'/index.html','utf8'),css=await readFile(root+'/styles.css','utf8');
 await page.setViewportSize({width:1440,height:900});await page.setContent(html);await page.addStyleTag({content:css});
 const before=await page.evaluate(geometry),injected=await page.addStyleTag({content:referenceResponsiveCss(css)});const after=await page.evaluate(geometry);
 // Mobile assertions exercise the files actually shipped to the generator.
 await injected.evaluate(node=>node.remove());
 const views=[];for(const width of [375,390,700]){await page.setViewportSize({width,height:900});views.push(await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth+1})));}
 results.push({reference:ref.id,desktopUnchanged:JSON.stringify(before)===JSON.stringify(after),views});console.log(JSON.stringify(results.at(-1)));
}
 await writeFile('.local-state/reference-template-smoke.json',JSON.stringify(results,null,2));
 if(results.some(r=>!r.desktopUnchanged||r.views.some(v=>v.overflow)))process.exitCode=1;
}finally{await browser.close();}
