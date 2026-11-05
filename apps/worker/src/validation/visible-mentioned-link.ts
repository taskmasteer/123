import type { Page } from 'playwright';

/** Checks rendered content, including mobile CSS, clipping and runtime removal.
 * Scrolls rather than following the external link; below-fold sections are valid.
 */
export async function visibleMentionedLink(page:Page,url:string):Promise<boolean>{
  return page.evaluate(expected=>{
    function visible(element:Element,interactive=false){
      if(!(element instanceof HTMLElement))return false;
      element.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      let opacity=1;
      for(let ancestor:Element|null=element;ancestor;ancestor=ancestor.parentElement){
        const css=getComputedStyle(ancestor);opacity*=Number(css.opacity);
        if(css.display==='none'||css.visibility!=='visible'||css.contentVisibility==='hidden'||opacity<0.05)return false;
      }
      if(interactive&&getComputedStyle(element).pointerEvents==='none')return false;
      const rect=element.getBoundingClientRect();
      const left=Math.max(0,rect.left),right=Math.min(innerWidth,rect.right),top=Math.max(0,rect.top),bottom=Math.min(innerHeight,rect.bottom);
      if(right-left<2||bottom-top<2)return false;
      // Sampling inside the visible rectangle catches overflow/clip-path and
      // covering layers without requiring the whole paragraph to fit on screen.
      return [0.25,0.5,0.75].some(y=>[0.25,0.5,0.75].some(x=>{
        const hit=document.elementFromPoint(left+(right-left)*x,top+(bottom-top)*y);
        return !!hit&&element.contains(hit);
      }));
    }
    for(const section of Array.from(document.querySelectorAll('[data-mentioned-link="true"]')).slice(0,100)){
      const headings=Array.from(section.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).filter(e=>e.innerText.trim()&&visible(e));
      const paragraphs=Array.from(section.querySelectorAll<HTMLElement>('p')).filter(e=>e.innerText.trim()&&visible(e));
      const links=Array.from(section.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(e=>e.getAttribute('href')===expected&&(!e.target||e.target==='_self')&&e.innerText.trim()&&visible(e,true));
      if(headings.length&&paragraphs.length&&links.length&&[...headings,...paragraphs,...links].map(e=>e.innerText.trim()).join(' ').length>=80)return true;
    }
    return false;
  },url);
}
