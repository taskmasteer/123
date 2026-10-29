import {test,expect} from './fixture.js';
test.describe('invite acceptance browser HTTP fixtures (not provider acceptance)',()=>{
 for(const scenario of ['success','expired','pending','password-retry'])test(scenario,async({page,workerBridge})=>{
  const id='11111111-1111-4111-8111-111111111111',user={id,email:'invite@example.test',aud:'authenticated',role:'authenticated'};
  const jwt=Buffer.from('{}').toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.fixture';
  const session={access_token:jwt,refresh_token:'fixture-refresh',expires_in:3600,token_type:'bearer',user};let verifies=0,passwords=0,pending=scenario==='pending';
  await page.route('https://fixture.supabase.co/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(path.endsWith('/verify')){verifies++;expect(req.postDataJSON()).toMatchObject({email:user.email,token:'123456',type:'invite'});return route.fulfill({status:scenario==='expired'?403:200,contentType:'application/json',body:JSON.stringify(scenario==='expired'?{code:'otp_expired',msg:'Token has expired or is invalid'}:session)});}
   if(path.endsWith('/user')&&req.method()==='PUT'){passwords++;expect(req.headers().authorization).toBe('Bearer '+jwt);expect(req.postDataJSON()).toEqual({password:'fixture-new-password',code_challenge:null,code_challenge_method:null});if(scenario==='password-retry'&&passwords===1)return route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({code:'weak_password',msg:'fixture policy'})});return route.fulfill({contentType:'application/json',body:JSON.stringify(user)});}
   if(path.endsWith('/token'))return route.fulfill({contentType:'application/json',body:JSON.stringify(session)});
   if(path.endsWith('/logout'))return route.fulfill({status:204});
   throw new Error('Unexpected Auth path '+path);
  });
  await page.route('https://control.example/**',async route=>{
   const path=new URL(route.request().url()).pathname;let result:unknown;
   if(pending)return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:{code:'FORBIDDEN',message:'Доступ к установке не предоставлен.'},requestId:'fixture'})});
   if(path==='/session')result={principal:{userId:id,role:'user'},mode:'managed',capabilities:{admin:false,edit:false,generation:false,publish:false,export:false,preview:false,nativeModelSettings:false}};
   else if(path==='/sites')result={items:[],nextCursor:null};else if(path==='/catalog')result={styles:[],references:[]};else throw Error('Unexpected control path');
   return route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.goto('/');await page.getByRole('button',{name:'Режим работы',exact:true}).click();await page.getByRole('button',{name:'Принять приглашение по коду',exact:true}).click();
  await page.getByLabel('Адрес общего API').fill('https://control.example');await page.getByLabel('Адрес проекта Supabase').fill('https://fixture.supabase.co');await page.getByLabel('Publishable key').fill('sb_publishable_fixture');await page.getByLabel('Email',{exact:true}).fill(user.email);await page.getByLabel('Код приглашения').fill('123456');
  const nativeCalls=workerBridge.requests.length;await page.getByRole('button',{name:'Подтвердить код',exact:true}).click();
  if(scenario==='expired'){
   await expect(page.getByRole('alert')).toContainText('Код недействителен или истёк');await expect(page.getByLabel('Код приглашения')).toHaveValue('');expect(passwords).toBe(0);
  }else{
   await expect(page.getByLabel('Новый пароль',{exact:true})).toBeVisible();await expect(page.getByLabel('Код приглашения')).toHaveCount(0);
   await page.getByLabel('Новый пароль',{exact:true}).fill('fixture-new-password');await page.getByRole('button',{name:'Сохранить пароль и войти',exact:true}).click();
   if(scenario==='password-retry'){await expect(page.getByRole('alert')).toContainText('Не удалось сохранить пароль');await expect(page.getByLabel('Новый пароль',{exact:true})).toHaveValue('');await page.getByLabel('Новый пароль',{exact:true}).fill('fixture-new-password');await page.getByRole('button',{name:'Сохранить пароль и войти',exact:true}).click();}
   if(scenario==='pending'){
    await expect(page.getByRole('alert')).toContainText('попросите администратора повторить приглашение');await expect(page.getByLabel('Пароль',{exact:true})).toHaveValue('');await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'.local-state/managed-invite-pending-viewport.png',fullPage:false});
    pending=false;await page.getByLabel('Пароль',{exact:true}).fill('fixture-new-password');await page.getByRole('button',{name:'Войти в общий реестр',exact:true}).click();
   }
   await expect(page.getByRole('button',{name:'Создать сайт',exact:true})).toBeVisible();expect(passwords).toBe(scenario==='password-retry'?2:1);
  }
  expect(verifies).toBe(1);expect(workerBridge.requests.length).toBe(nativeCalls);expect(JSON.stringify(workerBridge.requests)).not.toContain('fixture-new-password');
  expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain('fixture-refresh');
 });
});
