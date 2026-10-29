import {test,expect} from './fixture.js';
test('idle registry editor workers batch and publication stop DB requests and wake explicitly',async({page})=>{
 const id='11111111-1111-4111-8111-111111111111',revision='22222222-2222-4222-8222-222222222222';
 const counts:Record<string,number>={};let workerState='completed',batchState='preview',batchActive=false,publicationPending=false;
 const site={id,domain:'idle.example',ownerId:id,assignedUserIds:[],input:{domain:'idle.example',about:'A supplied concept'},revision:1,draftId:revision,publishedId:null,generationStatus:'completed',domainStatus:'pending',job:null};
 const summary=()=>({id,name:'idle.csv',state:batchState,revision:1,total:1,validCount:1,invalidCount:0,canControl:true,activeWork:batchActive});
 const jwt=Buffer.from('{}').toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:id,exp:Math.floor(Date.now()/1000)+7*86400})).toString('base64url')+'.fixture';
 await page.route('https://fixture.supabase.co/**',r=>r.fulfill({json:{access_token:jwt,refresh_token:'fixture',expires_in:7*86400,token_type:'bearer',user:{id,email:'owner@example.test',aud:'authenticated'}}}));
 await page.route('https://control.example/**',route=>{
  const request=route.request(),path=new URL(request.url()).pathname;let result:unknown,key=path;
  if(path==='/session')result={principal:{userId:id,role:'admin'},mode:'managed',capabilities:{admin:true,edit:true,generation:true,publish:true,export:false,preview:true,nativeModelSettings:false}};
  else if(path==='/catalog')result={styles:[],references:[]};else if(path==='/sites')result={items:[site],nextCursor:null};
  else if(path.endsWith('/health'))result={siteId:id,revisionId:null,outcomeId:null,checkedAt:null,status:null,code:'unverified',provenance:'managed'};
  else if(path.endsWith('/candidates'))result={candidates:[],publication:null};else if(path.endsWith('/chat'))result=[];else if(path.includes('/history'))result={items:[],nextOffset:null};
  else if(path==='/workers')result=[{id,name:'Idle device',paused:false,revoked:false,lastHeartbeat:null,jobs:[{id,siteId:id,stage:workerState==='running'?'validate':'completed',state:workerState}]}];
  else if(path==='/admin/users')result=[];
  else if(path==='/batches/commands'){const command=request.postDataJSON();key=command.method;if(command.method==='batch.list')result={items:[summary()],nextCursor:null};else if(command.method==='batch.get')result=summary();else if(command.method==='batch.rows')result={items:[{rowNumber:2,input:{rowNumber:2,domain:'terminal-row.test'},issues:[],siteId:id,job:{id,state:'completed',stage:'completed'}}],nextCursor:null};else throw Error(command.method);}
  else if(path.endsWith('/publication'))result={publication:{id,siteId:id,revisionId:revision,manifestId:revision,manifestHash:'a'.repeat(64),deploymentId:null,phase:publicationPending?'reconciling':'published',retryAt:null,cancelRequested:false,settlement:publicationPending?'pending':'settled',verifiedAt:null,origin:'generation'},domain:{records:[],verified:!publicationPending}};
  else throw Error(path);
  counts[key]=(counts[key]??0)+1;return route.fulfill({json:result});
 });
 await page.clock.install();await page.goto('/');await page.getByRole('button',{name:'Режим работы',exact:true}).click();
 for(const [label,value]of [['Адрес общего API','https://control.example'],['Адрес проекта Supabase','https://fixture.supabase.co'],['Publishable key','sb_publishable_fixture'],['Email','owner@example.test'],['Пароль','fixture']])await page.getByLabel(label!,{exact:true}).fill(value!);
 await page.getByRole('button',{name:'Войти в общий реестр'}).click();await expect(page.getByText('idle.example',{exact:true})).toBeVisible();
 const quiet=async()=>{await page.clock.pauseAt(new Date(await page.evaluate(()=>Date.now())+1000));const before={...counts};await page.clock.runFor(60*60*1000);expect(counts).toEqual(before);await page.clock.resume();};
 const refresh=async(name:string,key:string)=>{const before=counts[key]??0;await page.getByRole('button',{name,exact:true}).click();await expect.poll(()=>counts[key]??0).toBeGreaterThan(before);await page.clock.runFor(100);};
 const activeTick=async(key:string)=>{const before=counts[key]??0;await page.clock.pauseAt(new Date(await page.evaluate(()=>Date.now())+100));await page.clock.runFor(1500);await expect.poll(()=>counts[key]??0).toBeGreaterThan(before);await page.clock.resume();};
 await quiet();await refresh('Обновить','/sites');await quiet();
 const beforeFocus=counts['/sites']!;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect.poll(()=>counts['/sites']).toBeGreaterThan(beforeFocus);await quiet();
 await page.getByRole('button',{name:'Правки idle.example',exact:true}).click();await expect(page.getByRole('button',{name:'Обновить чат',exact:true})).toBeVisible();await expect.poll(()=>counts['/sites/'+id+'/candidates']??0).toBeGreaterThan(0);await quiet();await refresh('Обновить чат','/sites/'+id+'/candidates');await quiet();
 await page.getByRole('button',{name:'Исполнители',exact:true}).click();await expect(page.getByText('Idle device',{exact:true})).toBeVisible();await quiet();
 workerState='running';await refresh('Обновить устройства','/workers');await expect(page.getByText('Проверка · Выполняется',{exact:true})).toBeVisible();await activeTick('/workers');workerState='completed';await refresh('Обновить устройства','/workers');await expect(page.getByText('Завершено · Завершено',{exact:true})).toBeVisible();await quiet();
 await page.getByRole('button',{name:'Пачки',exact:true}).click();await page.getByRole('button',{name:'idle.csv — строк: 1, с ошибками: 0',exact:true}).click();await expect(page.getByText('Корректных строк: 1. С ошибками: 0.')).toBeVisible();await quiet();
 batchState='active';batchActive=true;await refresh('Обновить пачку','batch.get');await expect(page.getByRole('button',{name:'Пауза пачки',exact:true})).toBeVisible();await activeTick('batch.get');batchActive=false;await refresh('Обновить пачку','batch.get');await quiet();
 batchState='paused';batchActive=true;await refresh('Обновить пачку','batch.get');await quiet();
 await page.getByRole('button',{name:'Сайты',exact:true}).click();await page.getByRole('button',{name:'Публикация idle.example',exact:true}).click();await expect(page.getByRole('button',{name:'Обновить публикацию',exact:true})).toBeVisible();await expect.poll(()=>counts['/sites/'+id+'/publication']??0).toBeGreaterThan(0);await quiet();
 publicationPending=true;await refresh('Обновить публикацию','/sites/'+id+'/publication');await expect(page.getByText('Уточнение результата',{exact:true})).toBeVisible();await activeTick('/sites/'+id+'/publication');publicationPending=false;await refresh('Обновить публикацию','/sites/'+id+'/publication');await expect(page.getByText('Опубликовано',{exact:true})).toBeVisible();await quiet();
});
