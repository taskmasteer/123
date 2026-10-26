import {invoke} from '@tauri-apps/api/core';
export class DesktopClient {
 async request<T>(method:string,params:unknown={}):Promise<T>{
  try{return await invoke<T>('dispatch',{request:{id:crypto.randomUUID(),version:1,method,params}});}
  catch(error){throw new Error(message(error));}
 }
}
function message(error:unknown){
 const code=typeof error==='object'&&error!==null&&'code'in error?String(error.code):'';
 if(code==='DUPLICATE_DOMAIN')return 'Этот домен уже есть в списке.';
 if(code==='INVALID_INPUT')return 'Проверьте введённые данные. Укажите домен без пути и параметров.';
 if(code==='NOT_FOUND')return 'Запрошенный сайт или снимок не найден.';
 if(code==='FORBIDDEN')return 'Эта операция недоступна.';
 if(typeof error==='object'&&error!==null&&'message'in error)return String(error.message);
 return 'Исполнитель недоступен. Перезапустите приложение и повторите операцию.';
}
export const desktopClient=new DesktopClient();
