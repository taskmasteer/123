import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import type { ArtifactFile, SiteInput, ValidationReport } from '../../../../packages/contracts/src/model.js';
type Node=DefaultTreeAdapterMap['node'];
export function validateMentionedLink(files:ArtifactFile[],input:SiteInput):ValidationReport['issues']{
  if(!input.mentionedUrl)return [];
  const page=files.find(f=>f.path==='index.html');if(!page)return [];
  const stack:Node[]=[parse(new TextDecoder().decode(page.bytes))];let found=false,visited=0;
  while(stack.length){const node=stack.pop()!;if(++visited>20000)break;
    if('tagName' in node&&node.attrs.some(a=>a.name==='data-mentioned-link'&&a.value==='true')){
      const nodes:Node[]=[node],texts:string[]=[];let link=false,heading=false,paragraph=false,count=0;
      while(nodes.length){const child=nodes.pop()!;if(++count>20000)break;
        if(child.nodeName==='#text'&&'value'in child)texts.push(child.value);
        if('tagName'in child){const attrs=Object.fromEntries(child.attrs.map(a=>[a.name,a.value]));if(child.tagName==='a'&&attrs.href===input.mentionedUrl&&(!attrs.target||attrs.target==='_self'))link=true;if(/^h[1-6]$/.test(child.tagName))heading=true;if(child.tagName==='p')paragraph=true;}
        if('childNodes'in child)nodes.push(...child.childNodes);
      }
      if(link&&heading&&paragraph&&texts.join(' ').trim().length>=80)found=true;
    }
    if('childNodes'in node)stack.push(...node.childNodes);
  }
  return found?[]:[{code:'mentioned-link',path:'index.html',message:'Add a visible section marked data-mentioned-link="true" with heading, descriptive paragraph (at least 80 text characters total) and same-tab anchor to the exact supplied mentionedUrl.'}];
}
