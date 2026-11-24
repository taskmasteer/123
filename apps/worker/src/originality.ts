import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import type { ArtifactFile, Job, Lease } from '../../../packages/contracts/src/model.js';
import { browserLaunchOptions } from './browser-launch.js';

const formats = ['annotated walkthrough', 'decision guide', 'worked example', 'diagnostic checklist', 'comparative field guide', 'visual explanation', 'question-led tutorial', 'case exercise'];
const audiences = ['a first-time reader', 'someone comparing approaches', 'a practitioner checking their work', 'someone explaining the topic to a colleague', 'a reader troubleshooting an unexpected outcome', 'a reader preparing a small trial', 'someone reviewing a proposal', 'a reader testing an assumption'];
const lenses = ['trade-offs', 'sequence of decisions', 'boundary conditions', 'common mistakes', 'what to measure', 'how to verify the outcome', 'practical constraints', 'one concrete scenario'];

export function editorialDirection(seed: number, attempt = 0) {
  // Consecutive batch seeds enumerate unique combinations over a 512-row cycle.
  const n = ((seed + 53 * attempt) * 73) % 512;
  return `Design a ${formats[n % 8]} for ${audiences[Math.floor(n / 8) % 8]}, focused on ${lenses[Math.floor(n / 64)]}. Choose a specific question and give a useful, self-contained answer. Make the first screen and the order of sections serve that task. Keep all supplied facts and the requested subject. Never invent experience, endorsements or data.`;
}
export interface PageProfile {
  articleExcerpt?: string;
  digest: string;
  phrases: string[];
  vocabulary: string[];
  layouts: string[][];
  excerpt: string;
}
export interface Peer { digest: string; excerpt: string }
export type OriginalityDecision = {kind:'accepted'} | {kind:'duplicate'; reason:'text'|'layout'} | {kind:'review'; peers:Peer[]};
export interface OriginalityGate {
  profile(files: ArtifactFile[], includeArticle?:boolean): Promise<PageProfile>;
  reserve(job: Job, lease: Lease, profile: PageProfile, approved: string[]): Promise<OriginalityDecision>;
}

function hash(text: string) { return createHash('sha256').update(text).digest('hex'); }
const stop = new Set('this that with then have from your about which when they their into there these those will were some more what than them been also each only using through where other before after would should could'.split(' '));
export function profileFromRender(text: string, headings: string[], layouts: string[][]): PageProfile {
  const words = text.normalize('NFKC').toLowerCase().replace(/https?:\/\/[^\s]+/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? [];
  const vocabulary = new Map<string, number>(), phrases = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word.length > 3 && !stop.has(word)) vocabulary.set(word, (vocabulary.get(word) ?? 0) + 1);
    if (i >= 4) phrases.add(hash(words.slice(i-4, i+1).join(' ')).slice(0,16));
  }
  const excerpt = headings.slice(0,16).join(' | ').slice(0,800) + '\n' + text.replace(/\s+/g,' ').trim().slice(0,1600);
  return {digest:hash(JSON.stringify([words,layouts])), phrases:[...phrases].sort().slice(0,256),
    vocabulary:[...vocabulary].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,80).map(([word])=>word),
    layouts, excerpt};
}
export async function renderProfile(files: ArtifactFile[], includeArticle=false): Promise<PageProfile> {
  const browser = await chromium.launch({...browserLaunchOptions(true), timeout:15000});
  try {
    const context = await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'});
    const origin = 'https://render.invalid', byPath = new Map(files.map(file=>[file.path,file]));
    await context.route('**/*', async route=>{
      const url = new URL(route.request().url());
      const file = url.origin === origin && byPath.get(url.pathname.slice(1));
      if (!file) return route.abort();
      await route.fulfill({contentType:file.mediaType,body:Buffer.from(file.bytes),headers:{
        'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'",
        'X-DNS-Prefetch-Control':'off'}});
    });
    const page = await context.newPage(), layouts:string[][] = [];
    let text = '', headings:string[] = [], articleExcerpt:string|undefined;
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      await page.goto(origin+'/index.html',{waitUntil:'load',timeout:10000});
      const sample = await page.evaluate(()=>{
        const root = document.querySelector('main') ?? document.body;
        const elements = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,p,li,figure,table,blockquote,details,pre'))
          .filter(el=>el.offsetWidth && el.offsetHeight && getComputedStyle(el).visibility==='visible');
        const layout = elements.slice(0,64).map(el=>{
          const rect = el.getBoundingClientRect();
          return [el.tagName,Math.round(rect.left/innerWidth*12),Math.round(rect.width/innerWidth*12),
            Math.min(40,Math.round(rect.top/90)),Math.min(10,Math.round(rect.height/60))].join('/');
        });
        return {text:root.innerText.slice(0,60000),headings:elements.filter(el=>/^H[1-3]$/.test(el.tagName)).map(el=>el.innerText.slice(0,180)).slice(0,16),layout};
      });
      if (!text) {text=sample.text;headings=sample.headings;}
      layouts.push(sample.layout);
      if(includeArticle && width===1440) {
        // The next viewport loads a fresh document. Sample the rendered article
        // without allowing navigation or the mandatory link to supply its purpose.
        articleExcerpt=await page.evaluate(()=>{
          document.querySelectorAll('nav,footer,[data-mentioned-link="true"]').forEach(el=>el.remove());
          const article=(document.querySelector('main')??document.body).innerText.replace(/\s+/g,' ').trim();
          if(article.length<=7200)return article;
          const middle=Math.floor(article.length/2);
          return [article.slice(0,2400),article.slice(middle-1200,middle+1200),article.slice(-2400)].join('\n…\n');
        });
      }
    }
    const profile=profileFromRender(text,headings,layouts);
    if(articleExcerpt!==undefined)profile.articleExcerpt=articleExcerpt;
    return profile;
  } finally { await browser.close(); }
}

function overlap(a:string[], b:string[]) {
  const set = new Set(b), common = a.filter(value=>set.has(value)).length;
  return common / Math.max(1,a.length+b.length-common);
}
export function evaluatePeers(candidate:PageProfile, profiles:PageProfile[], approved:string[]):OriginalityDecision {
  const ranked = [];
  for (const peer of profiles) {
    const text = overlap(candidate.phrases,peer.phrases);
    if (candidate.digest===peer.digest || (candidate.phrases.length>=8 && text>=0.68)) return {kind:'duplicate',reason:'text'};
    const sameLayout = candidate.layouts.length===2 && candidate.layouts.every((view,index)=>{
      const other = peer.layouts[index] ?? [];
      return view.length>=8 && view.filter((value,i)=>value===other[i]).length / Math.max(view.length,other.length)>=0.88;
    });
    if (sameLayout) return {kind:'duplicate',reason:'layout'};
    ranked.push({peer,score:overlap(candidate.vocabulary,peer.vocabulary)+text});
  }
  const nearest = [...new Map(ranked.sort((a,b)=>b.score-a.score || a.peer.digest.localeCompare(b.peer.digest)).map(({peer})=>[peer.digest,peer])).values()].slice(0,4);
  const peers = nearest.filter(p=>!approved.includes(p.digest)).map(({digest,excerpt})=>({digest,excerpt}));
  return peers.length ? {kind:'review',peers} : {kind:'accepted'};
}
