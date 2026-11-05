import {afterEach,test,expect} from 'vitest';
import {validateSite} from '../src/validation/browser.js';
import {validateMentionedLink} from '../src/validation/mentioned-link.js';
import {site,file,directory,cleanDirectories} from './fixtures.js';
afterEach(cleanDirectories);
const url='https://resource.example/guide';
const section='<section data-mentioned-link="true"><h2>Recommended reading</h2><p>Explore this practical documentation resource to learn how to design reliable websites with useful examples and detailed explanations.</p><a href="'+url+'">Explore the guide</a></section>';
test('a visible mentioned section below the fold passes both viewport checks without opening the external link',async()=>{
 const files=site('<header style="height:1500px"><h1>Useful resources</h1></header>'+section);
 expect(validateMentionedLink(files,{domain:'fixture.example',mentionedUrl:url})).toEqual([]);
 expect(await validateSite(files,{mentionedUrl:url,screenshotRoot:await directory()})).toMatchObject({ok:true});
},30000);
test.each([
 ['display:none','section{display:none}'],
 ['transparent ancestor','body{opacity:0}'],
 ['clipped section','section{clip-path:inset(100%)}'],
 ['hidden on mobile','@media(max-width:600px){section{display:none}}'],
 ['unclickable anchor','section a{pointer-events:none}'],
 ['hidden paragraph','section p{display:none}'],
])('rejects structurally valid but invisible mention: %s',async(_name,css)=>{
 const files=site('<h1>Useful resources</h1>'+section,css);
 expect(validateMentionedLink(files,{domain:'fixture.example',mentionedUrl:url})).toEqual([]);
 const report=await validateSite(files,{mentionedUrl:url,screenshotRoot:await directory()});
 expect(report.ok).toBe(false);expect(report.issues.some(i=>i.code==='mentioned-link')).toBe(true);
},30000);
test('runtime removal and replacement of the required URL fail validation',async()=>{
 for(const script of ['document.querySelector("section").remove()','document.querySelector("section a").href="https://different.example/"']){
  const report=await validateSite(site('<h1>Useful resources</h1>'+section+'<script src="main.js"></script>').concat(file('main.js',script)),{mentionedUrl:url,screenshotRoot:await directory()});
  expect(report.issues.some(i=>i.code==='mentioned-link')).toBe(true);
 }
},30000);
