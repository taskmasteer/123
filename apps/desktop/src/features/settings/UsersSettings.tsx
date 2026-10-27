import React,{useEffect,useState} from 'react';
import {desktopClient} from '../../lib/desktop-client.js';
type User={id:string;email:string;role:'user'|'spec-user'|'admin';active:boolean};
export function UsersSettings(){const [users,setUsers]=useState<User[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const load=async()=>setUsers(await desktopClient.request<User[]>('admin.users'));
 useEffect(()=>{void load().catch(e=>setError(e.message));},[]);
 async function act(method:string,params:unknown){setBusy(true);setError('');try{await desktopClient.request(method,params);await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="device-panel"><h2>Пользователи и назначения</h2>{error?<p role="alert">{error}</p>:null}<p>user читает свои сайты. spec-user может редактировать свои и назначенные сайты. admin управляет установкой.</p>
 <form className="managed-form" onSubmit={e=>{e.preventDefault();const data=new FormData(e.currentTarget);void act('admin.invite',{email:data.get('email'),role:data.get('role')});}}><label>Email для приглашения<input name="email" type="email" required/></label><label>Роль нового пользователя<select name="role"><option>user</option><option>spec-user</option><option>admin</option></select></label><button disabled={busy}>Пригласить</button></form>
 {users.map(user=><div className="row-actions" key={user.id}><span>{user.email}</span><select aria-label={`Роль ${user.email}`} value={user.role} disabled={busy} onChange={e=>void act('admin.user.update',{id:user.id,role:e.target.value,active:user.active})}><option>user</option><option>spec-user</option><option>admin</option></select><button disabled={busy} onClick={()=>void act('admin.user.update',{id:user.id,role:user.role,active:!user.active})}>{user.active?'Отключить доступ':'Включить доступ'}</button></div>)}
 <form className="managed-form" onSubmit={e=>{e.preventDefault();const data=new FormData(e.currentTarget);void act('admin.assignments',{siteId:data.get('siteId'),userIds:data.getAll('userIds')});}}><label>ID сайта<input name="siteId" required/></label><label>Назначенные пользователи<select name="userIds" multiple>{users.filter(u=>u.active).map(u=><option key={u.id} value={u.id}>{u.email}</option>)}</select></label><button disabled={busy}>Сохранить назначения</button></form></section>;
}
