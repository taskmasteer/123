declare global {
 interface Window {factoryDesktop?:{
  endpoint:string;
  importConnection():Promise<boolean>;
  version:string;
  updateDownload():Promise<boolean>;
  request(path:string,method:string,body:unknown,csrf:string):Promise<{status:number;body:unknown}>;
  clearSession():Promise<void>;
  backupDownload(id:string):Promise<boolean>;
  saveAccess(text:string):Promise<boolean>;
  download(siteId:string,revisionId:string,path?:string):Promise<boolean>;
  external(url:string):Promise<void>;
  preview(url:string):Promise<void>;
  copyKey(code:string):Promise<void>;
 };}
}
let sessionEpoch=0,sessionActive=false;
export const sessionExpiredEvent='factory:session-expired';
export function activateSession(){sessionEpoch++;sessionActive=true;}
export async function clearSession(){sessionEpoch++;sessionActive=false;await window.factoryDesktop?.clearSession();}
export async function appFetch(path:string,init?:RequestInit):Promise<Response>{
 const epoch=sessionEpoch,protectedRequest=path.startsWith('/api/');
 if(protectedRequest&&!sessionActive)return Response.json({error:{code:'UNAUTHENTICATED',message:'Войдите в систему.'}},{status:401});
 const response=window.factoryDesktop
  ?await window.factoryDesktop.request(path,init?.method??'GET',init?.body?JSON.parse(String(init.body)):undefined,new Headers(init?.headers).get('x-csrf-token')??'').then(result=>Response.json(result.body,{status:result.status}))
  :await fetch(path,init);
 if(response.status===401&&protectedRequest&&sessionActive&&epoch===sessionEpoch){sessionActive=false;window.dispatchEvent(new Event(sessionExpiredEvent));}
 return response;
}
