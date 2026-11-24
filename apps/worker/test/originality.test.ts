import {readFile} from 'node:fs/promises';
import {referenceStarter} from '../src/reference-starter.js';
import {describe,expect,test,vi} from 'vitest';
import {evaluatePeers,editorialDirection,profileFromRender,renderProfile,type OriginalityGate,type PageProfile} from '../src/originality.js';
import {automaticTopicField,checkOriginality,type EditorialState} from '../src/editorial-review.js';
import type {Job,Lease} from '../../../packages/contracts/src/model.js';

const page=(copy:string,layouts:string[][]=[[],[]])=>profileFromRender(copy,[],layouts);
const original=page('Follow the trail along the river to the footbridge and measure the height of the water at the marker.');
const paraphrase=page('Walk beside the stream until you reach the crossing. Record the distance between the surface and the gauge.');
const alternative=page('Identify a constellation using a fixed landmark. At successive intervals sketch the position of its brightest star.');
describe('automatic editorial pipeline',()=>{
  test('four neighboring auto-topic rows get four distinct disciplines, including across seed wrap',()=>{
    for(const seed of [0,5,15,0xfffffffe]) {
      const fields=Array.from({length:4},(_,row)=>automaticTopicField((seed+row)>>>0));
      expect(new Set(fields).size).toBe(4);
      expect(automaticTopicField(seed)).toBe(fields[0]);
    }
  });
  test('subject review reads the article independently of the recommended resource',async()=>{
    const html='<main><h1>Photo archives</h1><p>Label each album by year.</p><section data-mentioned-link="true"><p>A technical cryptocurrency tutorial</p></section></main>';
    const profile=await renderProfile([{path:'index.html',mediaType:'text/html',bytes:Buffer.from(html)}],true);
    expect(profile.articleExcerpt).toContain('Label each album');
    expect(profile.articleExcerpt).not.toContain('cryptocurrency');
    expect(profile.excerpt).toContain('cryptocurrency');
  });
  test.each(['missing_connection','missing_purpose'])('checks the first site, repairs %s, and reuses the saved subject verdict',async initialVerdict=>{
    let candidate={...original,articleExcerpt:'A list of photo album names.'},attempts=0;
    const state:EditorialState={version:1,approved:[]},reserve=vi.fn(async()=>({kind:'accepted'} as const));
    const judge=vi.fn(async()=>attempts?'suitable':initialVerdict);
    const options={state,gate:{profile:async()=>candidate,reserve},job:{} as Job,lease:()=>({} as Lease),files:()=>[],input:{domain:'field.example'},seed:1,checkSubject:true,
      attempt:()=>attempts,save:async()=>{},judge,repair:async()=>{expect(reserve).not.toHaveBeenCalled();attempts++;candidate={...alternative,articleExcerpt:'A worked example of checking a wallet release signature.'};}};
    await checkOriginality(options);await checkOriginality(options);
    expect(attempts).toBe(1);expect(judge).toHaveBeenCalledTimes(2);expect(state.subjectApproved).toBe(alternative.digest);
  });
  test('an unrelated article is held before reservation even when it is the only site',async()=>{
    let repairs=0;
    const reserve=vi.fn(async()=>({kind:'accepted'} as const));
    await expect(checkOriginality({
      state:{version:1,approved:[]},gate:{profile:async()=>({...original,articleExcerpt:'A guide to growing basil.'}),reserve},
      job:{} as Job,lease:()=>({} as Lease),files:()=>[],input:{domain:'garden.example'},seed:3,checkSubject:true,
      attempt:()=>repairs,save:async()=>{},judge:async()=>'missing_connection',repair:async()=>{repairs++;},
    })).rejects.toThrow('Site subject requirements not met.');
    expect(repairs).toBe(2);expect(reserve).not.toHaveBeenCalled();
  });
  test('library artwork, scripts and original text do not enter the generated website',()=>{
    const asset={path:'reference-brand.svg',mediaType:'image/svg+xml',bytes:Buffer.from('<svg/>')};
    const html={path:'index.html',mediaType:'text/html',bytes:Buffer.from('<p>Unlicensed sample copy</p>')};
    for(const files of [[asset],[html,asset],[html,asset,{path:'styles.css',mediaType:'text/css',bytes:Buffer.from('body{color:#abc}')}]]){
      const starter=referenceStarter(files);
      expect(starter.map(f=>f.path)).toEqual(['index.html','styles.css']);
      expect(Buffer.from(starter[0]!.bytes).toString()).not.toContain('Unlicensed sample copy');
    }
  });
  test('a full batch has distinct, restart-stable assignments',()=>{
    const plans=Array.from({length:256},(_,i)=>editorialDirection(0xffffff00+i));
    expect(new Set(plans).size).toBe(256);expect(editorialDirection(55,1)).not.toBe(editorialDirection(55));
  });
  test('keeps the visual samples from each library layout within a small starting document',async()=>{
    const catalog=JSON.parse(await readFile('templates/catalog.json','utf8')) as {id:string;enabled:boolean}[];
    const references=catalog.filter(s=>s.enabled && s.id.startsWith('reference-'));
    expect(references.length).toBeGreaterThan(0);
    for(const ref of references) {
      const [html,css]=await Promise.all(['index.html','styles.css'].map(path=>readFile('templates/'+ref.id+'/'+path)));
      const files=referenceStarter([{path:'index.html',mediaType:'text/html',bytes:html!},{path:'styles.css',mediaType:'text/css',bytes:css!}]);
      const style=Buffer.from(files[1]!.bytes).toString();
      expect(style,ref.id).toMatch(/Palette: (?:rgb|#)/);
      expect(files.reduce((size,f)=>size+f.bytes.length,0)).toBeLessThan(2500);
      expect(Buffer.from(files[0]!.bytes).toString()).not.toMatch(/Content \d+|ref-s\d/);
    }
  });
  test('checks every stored site for copied text and both viewports for repeated layouts',()=>{
    const peers=Array.from({length:40},(_,i)=>page('Guide '+i));
    expect(evaluatePeers(original,[...peers,original],[])).toEqual({kind:'duplicate',reason:'text'});
    const layout=Array.from({length:12},(_,i)=>'H2/'+i);
    expect(evaluatePeers({...alternative,layouts:[layout,layout]},[{...original,layouts:[layout,layout]}],[])).toEqual({kind:'duplicate',reason:'layout'});
    expect(evaluatePeers(paraphrase,[original],[]).kind).toBe('review');
    expect(evaluatePeers(paraphrase,[original],[original.digest]).kind).toBe('accepted');
  });
  test.each([false,true])('semantic duplicate is redesigned, persistent duplicates stop before archive (persistent=%s)',async persistent=>{
    let candidate=paraphrase,attempts=0; const accepted:PageProfile[]=[];
    const gate:OriginalityGate={profile:async()=>candidate,reserve:async(_job,_lease,profile,approved)=>{
      const decision=evaluatePeers(profile,[original],approved);if(decision.kind==='accepted')accepted.push(profile);return decision;
    }};
    const state:EditorialState={version:1,approved:[]};
    const judge=vi.fn(async()=>candidate.digest===alternative.digest?'distinct':'duplicate');
    const result=checkOriginality({state,gate,job:{} as Job,lease:()=>({} as Lease),files:()=>[],input:{domain:'field.example'},seed:1,
      attempt:()=>attempts,save:async()=>{},judge,repair:async()=>{attempts++;if(!persistent)candidate=alternative;}});
    if(persistent){await expect(result).rejects.toThrow('Originality repairs exhausted');expect(attempts).toBe(2);expect(accepted).toEqual([]);}
    else{await result;expect(attempts).toBe(1);expect(accepted).toEqual([alternative]);}
  });
});
