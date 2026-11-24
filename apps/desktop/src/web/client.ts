import { RemoteClient } from '../lib/remote-client.js';
import { selectClient } from '../lib/desktop-client.js';
import {appFetch,activateSession,clearSession} from '../lib/native.js';
export type User={id:string;login:string;csrf:string};
let csrf='';
export async function api<T>(path:string,body?:unknown):Promise<T>{
  const response=await appFetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-csrf-token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error'});
  const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error?.message??'Операция не выполнена.'),{code:result.error?.code,status:response.status});return result;
}
export async function logout(){
 // Bound the remote revoke attempt; a disconnected server cannot trap the user.
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([api('/auth/logout',{}).catch(()=>{}),new Promise<void>(resolve=>{timer=setTimeout(resolve,1500);})]);}
 finally{if(timer)clearTimeout(timer);csrf='';await clearSession();}
}
export function connect(user:User){
  csrf=user.csrf;activateSession();
  const transport:typeof fetch=async(input,init)=>{
    const url=new URL(String(input)),headers=new Headers(init?.headers);headers.delete('authorization');headers.set('x-csrf-token',csrf);
    const response=await appFetch('/api'+url.pathname+url.search,{...init,headers,credentials:'same-origin'});
    if(!response.ok){const error=await response.json();return Response.json({...error,requestId:crypto.randomUUID()},{status:response.status});}
    return response;
  };
  const remote=new RemoteClient(window.factoryDesktop?.endpoint??location.origin,async()=> 'cookie-session',transport);
  selectClient(remote);
  return remote;
}
