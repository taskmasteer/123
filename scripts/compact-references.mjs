import './lib/browser-env.mjs';
import {chromium} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {referenceResponsiveCss} from './lib/reference-responsive.mjs';
const root=resolve(import.meta.dirname,'..'),refs=JSON.parse(await readFile(resolve(root,'references/catalog.json'),'utf8'));
const browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.route('**/*',r=>r.abort());
try{for(const ref of refs){
 const dir=resolve(root,'templates/reference-'+ref.id),html=await readFile(resolve(dir,'index.html'),'utf8'),css=await readFile(resolve(dir,'styles.css'),'utf8');
 if(!html.includes('style=')){
  if(!css.includes('/* Responsive reference geometry:'))await writeFile(resolve(dir,'styles.css'),css+referenceResponsiveCss(css));
  continue;
 }
 await page.setContent(html);
 const result=await page.evaluate(()=>{
  const rules=new Map();for(const e of document.querySelectorAll('[style]')){
   for(const p of ['box-shadow','border-radius','min-height','max-width','margin','padding','letter-spacing']){const v=e.style.getPropertyValue(p);if(['none','normal','0px','auto','0px 0px'].includes(v))e.style.removeProperty(p);}
   const value=e.getAttribute('style');if(!rules.has(value))rules.set(value,'ref-s'+rules.size);
   e.classList.add(rules.get(value));e.removeAttribute('style');
  }
  return {html:'<!doctype html>\n'+document.documentElement.outerHTML,css:[...rules].map(([v,k])=>'.'+k+'{'+v+'}').join('\n')};
 });
 const compactCss=(result.css+'\n'+css).replace(/font-size:\s*(\d+(?:\.\d+)?)px/g,(m,n)=>Number(n)<12?'font-size: 12px':m);
 await writeFile(resolve(dir,'index.html'),result.html);await writeFile(resolve(dir,'styles.css'),compactCss+referenceResponsiveCss(compactCss));
 console.log(ref.id+': '+html.length+' -> '+(result.html.length+result.css.length));
}}finally{await browser.close();}
