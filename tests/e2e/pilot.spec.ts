import {test,expect} from './fixture.js';
import {mkdir,writeFile} from 'node:fs/promises';
const directions=['light-product','dark-tech','editorial','corporate','diagram'];
for(const [index,direction] of directions.entries())test(`fixture pilot ${direction} with ${index%2?'automatic':'manual'} subject`,async({page})=>{
 const began=performance.now(),domain=`pilot-${direction}.test`;
 await mkdir('.local-state/pilot',{recursive:true});
 await page.goto('/');await page.getByRole('button',{name:'Создать сайт',exact:true}).click();
 await page.getByLabel('Домен',{exact:true}).fill(domain);
 if(index%2===0)await page.getByLabel('О чём сайт').fill('A personal noncommercial guide to calm, reliable garden tools.');
 await page.getByRole('combobox',{name:'Референс',exact:true}).selectOption(direction);
 await page.getByRole('button',{name:'Создать',exact:true}).click();
 await expect(page.getByText('Локальная версия готова',{exact:true})).toBeVisible({timeout:30000});
 await page.getByRole('button',{name:`Снимок ${domain}`}).click();
 for(const width of [1440,375]){
  await page.getByRole('button',{name:`${width} px`}).click();
  const image=page.getByRole('img',{name:`Снимок сайта ${domain}`});await expect(image).toBeVisible();
  await expect.poll(()=>image.evaluate((node:HTMLImageElement)=>node.complete&&node.naturalWidth)).toBe(width);
  await image.screenshot({path:`.local-state/pilot/${direction}-${width}.png`});
 }
 await page.getByRole('button',{name:'Закрыть снимок'}).click();
 const metrics=await page.evaluate(async domain=>{
  const call=(method:string,params:Record<string,unknown>={})=>(window as unknown as {__desktopTestDispatch:(request:unknown)=>Promise<any>}).__desktopTestDispatch({id:'pilot-metrics',version:1,method,params});
  const site=(await call('site.list')).items.find((site:any)=>site.domain===domain);
  return {siteId:site.id,usage:await call('site.usage',{siteId:site.id}),generationStatus:site.generationStatus};
 },domain);
 expect(metrics.generationStatus).toBe('completed');
 await writeFile(`.local-state/pilot/${direction}.json`,JSON.stringify({fixture:true,direction,subject:index%2?'automatic':'manual',elapsedMs:performance.now()-began,...metrics,providerUsage:'synthetic/unknown; no live model calls',visualAssessment:'pending user'},null,2));
});
