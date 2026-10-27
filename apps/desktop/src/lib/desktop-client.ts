import {invoke} from '@tauri-apps/api/core';
export class DesktopClient {
 async modelSettings<T>(request: {action:'status'|'delete'|'demo'}|{action:'save';apiKey:string;model:string;imageModel?:string}):Promise<T>{
  try{return await invoke<T>('model_settings',{request});}
  catch(error){throw new DesktopError(message(error),typeof error==='object'&&error!==null&&'code'in error?String(error.code):'NEEDS_ATTENTION');}
 }
 async request<T>(method:string,params:unknown={}):Promise<T>{
  try{return await invoke<T>('dispatch',{request:{id:crypto.randomUUID(),version:1,method,params}});}
  catch(error){throw new DesktopError(message(error),typeof error==='object'&&error!==null&&'code'in error?String(error.code):'NEEDS_ATTENTION');}
 }
}
export class DesktopError extends Error {
 constructor(message:string,public readonly code:string){super(message);this.name='DesktopError';}
}
function message(error:unknown){
 const code=typeof error==='object'&&error!==null&&'code'in error?String(error.code):'';
 if(code==='DUPLICATE_DOMAIN')return 'Этот домен уже есть в списке.';
 if(code==='INVALID_INPUT')return 'Проверьте введённые данные и повторите операцию.';
 if(code==='NOT_FOUND')return 'Запрошенный сайт или снимок не найден.';
 if(code==='FORBIDDEN')return 'Эта операция недоступна.';
 if(typeof error==='object'&&error!==null&&'message'in error)return String(error.message);
 return 'Исполнитель недоступен. Перезапустите приложение и повторите операцию.';
}
export interface Client {request<T>(method:string,params?:unknown):Promise<T>;modelSettings<T>(request:Parameters<DesktopClient['modelSettings']>[0]):Promise<T>;dispose?():void}
const localClient=new DesktopClient();
let activeClient:Client=localClient;
export function selectClient(client:Client|'local'){activeClient.dispose?.();activeClient=client==='local'?localClient:client;}
export const desktopClient:Client={request:(method,params)=>activeClient.request(method,params),modelSettings:request=>activeClient.modelSettings(request)};
