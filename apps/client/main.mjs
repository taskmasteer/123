import {app,BrowserWindow,ipcMain,protocol,session,dialog,clipboard,nativeTheme,shell} from 'electron';
import {readFile,writeFile,open,rename,rm} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {X509Certificate,randomUUID,createHash} from 'node:crypto';
import {validateConnection,createConnection} from './connection.mjs';
import {readConnectionFile,probeConnection,saveConnectionFile} from './connection-file.mjs';
nativeTheme.themeSource='dark';
const root=import.meta.dirname,appOrigin='factory://app';
protocol.registerSchemesAsPrivileged([{scheme:'factory',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
if(!app.requestSingleInstanceLock()){app.quit();}else{
 async function start(){
 let main,connection,config;
 const trusted=event=>{if(!main||event.sender!==main.webContents||event.senderFrame!==main.webContents.mainFrame||!event.senderFrame.url.startsWith(appOrigin+'/'))throw new Error('Untrusted application frame.');};
 app.on('second-instance',()=>{main?.show();main?.focus();});
 await app.whenReady();
 const savedConnection=resolve(app.getPath('userData'),'server-connection.json');
 try{config=await readConnectionFile(savedConnection);}catch(e){if(e.code==='ENOENT'){try{config=await readConnectionFile(resolve(root,'connection.json'));}catch{}}}
 connection=config?createConnection(config):{clear(){},async request(){throw Error('Выберите файл подключения к серверу.');}};
 let endpoint=config?new URL(config.endpoint):null;const ses=session.defaultSession;
  ses.setPermissionRequestHandler((_web,_permission,callback)=>callback(false));ses.setPermissionCheckHandler(()=>false);
  ses.setCertificateVerifyProc((request,callback)=>{
   try{const cert=new X509Certificate(request.certificate.data),now=Date.now();callback(request.hostname===endpoint?.hostname&&cert.fingerprint256===config?.fingerprint&&now>=Date.parse(cert.validFrom)&&now<Date.parse(cert.validTo)?0:-2);}catch{callback(-2);}
  });
  ses.webRequest.onBeforeRequest((details,callback)=>{
   const u=new URL(details.url);callback({cancel:!(u.protocol==='factory:'&&u.hostname==='app'||u.origin===endpoint?.origin&&u.pathname.startsWith('/preview/'))});
  });
  protocol.handle('factory',async request=>{
   const url=new URL(request.url);if(url.hostname!=='app'||!['GET','HEAD'].includes(request.method))return new Response(null,{status:404});
   const web=resolve(root,'ui'),file=resolve(web,url.pathname==='/'?'web.html':decodeURIComponent(url.pathname.slice(1)));
   if(!file.startsWith(web+sep))return new Response(null,{status:404});
   try{const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
    return new Response(await readFile(file),{headers:{'content-type':mime[extname(file)]??'application/octet-stream','content-security-policy':`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src ${config?.endpoint??"'none'"}; object-src 'none'; base-uri 'none'; form-action 'none'`}});
   }catch{return new Response(null,{status:404});}
  });
  ipcMain.handle('factory:import-connection',async event=>{
   trusted(event);const choice=await dialog.showOpenDialog(main,{title:'Файл подключения к API',properties:['openFile'],filters:[{name:'Подключение Site Factory',extensions:['json','sfconnection']}]});if(choice.canceled)return false;
   const next=await readConnectionFile(choice.filePaths[0]);
   const confirm=await dialog.showMessageBox(main,{type:'question',title:'Подключение к серверу',message:'Использовать этот сервер?',detail:next.endpoint+'\nСертификат: '+next.fingerprint,buttons:['Подключиться','Отмена'],defaultId:1,cancelId:1});if(confirm.response!==0)return false;
   await probeConnection(next);await saveConnectionFile(savedConnection,next);
   connection.clear();for(const win of BrowserWindow.getAllWindows())if(win!==main)win.close();config=next;endpoint=new URL(next.endpoint);connection=createConnection(next);await ses.clearCache();await main.reload();return true;
  });
  ipcMain.on('factory:version',event=>{event.returnValue=app.getVersion();});
  ipcMain.handle('factory:update-download',async event=>{
   trusted(event);const response=await connection.request('/api/client-release');if(response.status!==200)throw Error('Не удалось проверить обновление.');
   const release=JSON.parse(response.bytes.toString());if(!release.available||release.protocol!==1||!/^[a-f0-9]{64}$/.test(release.sha256)||!Number.isSafeInteger(release.size)||release.size<1||release.size>512*1024*1024)throw Error('Некорректный пакет обновления.');
   const choice=await dialog.showSaveDialog(main,{defaultPath:'SiteFactory-update.zip',filters:[{name:'Обновление Site Factory',extensions:['zip']}]});if(choice.canceled)return false;
   const pending=choice.filePath+'.partial-'+randomUUID();let file;
   try{file=await open(pending,'wx',0o600);const digest=createHash('sha256');for(let offset=0;offset<release.size;offset+=1024*1024){const part=await connection.request('/api/client-release/'+release.sha256+'?offset='+offset,'GET',undefined,1024*1024);if(part.status!==200||part.bytes.length!==Math.min(1024*1024,release.size-offset))throw Error('Загрузка обновления прервана.');digest.update(part.bytes);await file.writeFile(part.bytes);}if(digest.digest('hex')!==release.sha256)throw Error('Контрольная сумма обновления не совпадает.');await file.sync();await file.close();file=null;await rename(pending,choice.filePath);return true;}finally{await file?.close();await rm(pending,{force:true});}
  });
  ipcMain.on('factory:connection',(event)=>{try{trusted(event);event.returnValue=config?.endpoint??'';}catch{event.returnValue='';}});
  ipcMain.handle('factory:request',async(event,input)=>{
   trusted(event);if(!input||typeof input.path!=='string'||input.path.length>5000||!['GET','POST','PATCH'].includes(input.method))throw new Error('Invalid request.');
   const result=await connection.request(input.path,input.method,input.body,4*1024*1024,input.csrf);
   let body;try{body=JSON.parse(result.bytes.toString());}catch{throw new Error('Некорректный ответ службы.');}return {status:result.status,body};
  });
  ipcMain.handle('factory:clear-session',event=>{trusted(event);connection.clear();for(const win of BrowserWindow.getAllWindows())if(win!==main)win.close();});
  ipcMain.handle('factory:backup-download',async(event,id)=>{
   trusted(event);if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid backup id.');
   const choice=await dialog.showSaveDialog(main,{defaultPath:'site-factory-'+id+'.sfbak',filters:[{name:'Зашифрованная резервная копия',extensions:['sfbak']}]});if(choice.canceled)return false;
   const info=await connection.request('/api/recovery/backups/'+id+'/info');if(info.status!==200)throw Error('Копия недоступна. Войдите снова и повторите.');
   const size=JSON.parse(info.bytes.toString()).size;if(!Number.isSafeInteger(size)||size<1||size>48*1024**3+80)throw Error('Invalid backup size.');
   const pending=choice.filePath+'.partial-'+randomUUID();let file;
   try{file=await open(pending,'wx',0o600);for(let offset=0;offset<size;offset+=1024*1024){
     const part=await connection.request('/api/recovery/backups/'+id+'/chunk?offset='+offset,'GET',undefined,1024*1024);
     if(part.status!==200||part.bytes.length!==Math.min(1024*1024,size-offset))throw Error('Скачивание прервано. Повторите; прежний файл сохранён.');
     await file.writeFile(part.bytes);
   }await file.sync();await file.close();file=null;await rename(pending,choice.filePath);return true;
   }finally{await file?.close();await rm(pending,{force:true});}
  });
  ipcMain.handle('factory:save-access',async(event,text)=>{trusted(event);if(typeof text!=='string'||text.length>5000)throw new Error('Invalid access file.');const choice=await dialog.showSaveDialog(main,{defaultPath:'site-factory-access.txt',filters:[{name:'Текстовый файл',extensions:['txt']}]});if(choice.canceled)return false;await writeFile(choice.filePath,text,{encoding:'utf8',mode:0o600});return true;});
  ipcMain.handle('factory:download',async(event,input)=>{
   trusted(event);if(!/^[a-f0-9-]{36}$/.test(input?.siteId)||!/^[a-f0-9-]{36}$/.test(input?.revisionId)||input.path!==undefined&&(typeof input.path!=='string'||input.path.length>240))throw new Error('Invalid source request.');
   const name=input.path?input.path.split('/').at(-1):`site-${input.siteId}.zip`,choice=await dialog.showSaveDialog(main,{defaultPath:name});if(choice.canceled)return false;
   const query=new URLSearchParams({revisionId:input.revisionId,...(input.path?{path:input.path}:{})}),result=await connection.request(`/api/sites/${input.siteId}/download?${query}`,'GET',undefined,70*1024*1024);
   if(result.status!==200)throw new Error('Не удалось скачать исходники.');await writeFile(choice.filePath,result.bytes);return true;
  });
  const openPreview=url=>{
   const target=new URL(url);if(target.origin!==endpoint?.origin||!target.pathname.startsWith('/preview/')||target.username||target.password)throw new Error('Invalid preview.');
   const preview=new BrowserWindow({title:'Предпросмотр сайта',width:1200,height:850,parent:main,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});preview.setMenu(null);preview.webContents.setWindowOpenHandler(()=>({action:'deny'}));preview.webContents.on('will-navigate',(event,next)=>{if(next!==url)event.preventDefault();});void preview.loadURL(url);
  };
  ipcMain.handle('factory:external',async(event,value)=>{trusted(event);if(typeof value!=='string'||value.length>2048)throw new Error('Invalid URL');const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid URL');await shell.openExternal(url.href);});
  ipcMain.handle('factory:preview',(event,url)=>{trusted(event);openPreview(url);});
  ipcMain.handle('factory:copy-key',(event,code)=>{trusted(event);if(typeof code!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(code))throw new Error('Invalid registration key.');clipboard.writeText(code);});
  main=new BrowserWindow({title:'Site Factory',width:1360,height:900,minWidth:900,minHeight:650,backgroundColor:'#101011',show:false,webPreferences:{preload:resolve(root,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});
  main.setMenu(null);main.webContents.setWindowOpenHandler(()=>({action:'deny'}));main.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(appOrigin+'/'))event.preventDefault();});main.webContents.on('will-attach-webview',event=>event.preventDefault());
  main.once('ready-to-show',()=>main.show());await main.loadURL(appOrigin+'/');
  app.on('window-all-closed',()=>{connection.clear();app.quit();});
 }
 void start().catch(error=>{console.error('Desktop startup failed:',error.message);app.quit();});
}
