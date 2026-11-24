import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { AppError } from '../../../packages/contracts/src/model.js';
const derive = (password:string,salt:string,length:number,options:import('node:crypto').ScryptOptions) => new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,length,options,(error,key)=>error?reject(error):resolve(key)));
export const tokenHash = (value:string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
export async function passwordHash(password:string) {
  if(typeof password!=='string'||password.length<12||password.length>256)throw new AppError('INVALID_INPUT','Пароль: от 12 до 256 символов.');
  const salt=randomBytes(16).toString('hex');
  const key=await derive(password,salt,64,{N:131072,r:8,p:1,maxmem:256*1024*1024}) as Buffer;
  return salt+':'+key.toString('hex');
}
async function passwordMatches(password:string,stored:string){
  const [salt,expected]=stored.split(':');if(!salt||!expected||password.length>256)return false;
  const key=await derive(password,salt,64,{N:131072,r:8,p:1,maxmem:256*1024*1024}) as Buffer;
  const bytes=Buffer.from(expected,'hex');return bytes.length===key.length&&timingSafeEqual(bytes,key);
}
export function loginInput(value:unknown){
  if(typeof value!=='string'||! /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,31}$/.test(value.trim()))throw new AppError('INVALID_INPUT','Логин: 3–32 символа, латинские буквы, цифры, точка, дефис или подчёркивание.');
  return value.trim().toLowerCase();
}
export class LocalAuth {
  private hashing=0;
  constructor(readonly pool:Pool){}
  async audit(actor:string|null,action:string){await this.pool.query('insert into factory.audit(actor,action) values($1,$2)',[actor,action]);}
  async limit(key:string,max=8){
    const row=(await this.pool.query(`insert into factory.attempts values($1,1,now()+interval '15 minutes') on conflict(key) do update set count=case when factory.attempts.until_at<now() then 1 else factory.attempts.count+1 end,until_at=case when factory.attempts.until_at<now() then now()+interval '15 minutes' else factory.attempts.until_at end returning count`,[tokenHash(key)])).rows[0];
    if(row.count>max)throw new AppError('UNAVAILABLE','Слишком много попыток. Повторите через 15 минут.');
  }
  async bootstrapAvailable(){return !(await this.pool.query('select 1 from factory.accounts limit 1')).rowCount;}
  async register(input:{login:unknown;password:unknown;invite:unknown},bootstrap:boolean){
    const login=loginInput(input.login);if(typeof input.password!=='string')throw new AppError('INVALID_INPUT','Укажите пароль.');
    // Cheap admission before scrypt; the invite is checked/consumed again under lock.
    if(!bootstrap||!await this.bootstrapAvailable())await this.checkInvite(input.invite);
    if(this.hashing>=2)throw new AppError('UNAVAILABLE','Повторите через несколько секунд.');
    this.hashing++;let hash:string;try{hash=await passwordHash(input.password);}finally{this.hashing--;}
    const tx=await this.pool.connect(),id=randomUUID();
    try{await tx.query('begin');await tx.query('select pg_advisory_xact_lock(78424520)');
      const first=!(await tx.query('select 1 from factory.accounts limit 1')).rowCount;
      if(!first||!bootstrap){
        if(typeof input.invite!=='string'||input.invite.length>100)throw new AppError('FORBIDDEN','Нужно действующее приглашение.');
        const row=(await tx.query('select * from factory.invites where hash=$1 and used_at is null and expires_at>now() for update',[tokenHash(input.invite)])).rows[0];
        if(!row||row.login&&row.login!==login)throw new AppError('FORBIDDEN','Ключ регистрации недействителен, уже использован или истёк.');
        await tx.query('update factory.invites set used_at=now() where hash=$1',[tokenHash(input.invite)]);
      }
      if((await tx.query('select 1 from factory.accounts where login=$1',[login])).rowCount)throw new AppError('CONFLICT','Этот логин уже занят.');
      await tx.query('insert into auth.users values($1)',[id]);await tx.query('insert into public.users(id) values($1)',[id]);
      await tx.query("insert into public.memberships values($1,'admin',true)",[id]);await tx.query('insert into factory.accounts(id,password_hash,login) values($1,$2,$3)',[id,hash,login]);
      await tx.query("insert into factory.audit(actor,action) values($1,'account.register')",[id]);await tx.query('commit');
    }catch(e){await tx.query('rollback');throw e;}finally{tx.release();}
    return this.newSession(id);
  }
  async login(loginValue:unknown,password:unknown){
    const login=loginInput(loginValue);if(typeof password!=='string'||password.length>256)throw new AppError('UNAUTHENTICATED','Неверный логин или пароль.');
    await this.limit('account:'+login);
    const row=(await this.pool.query('select a.id,a.password_hash from factory.accounts a join public.memberships m on m.user_id=a.id where a.login=$1 and m.active',[login])).rows[0];
    if(this.hashing>=2)throw new AppError('UNAVAILABLE','Повторите через несколько секунд.');this.hashing++;
    let matches=false;try{matches=await passwordMatches(password,row?.password_hash??'00000000000000000000000000000000:'+ '0'.repeat(128));}finally{this.hashing--;}
    if(!row||!matches)throw new AppError('UNAUTHENTICATED','Неверный логин или пароль.');
    await this.pool.query('delete from factory.attempts where key=$1',[tokenHash('account:'+login)]);await this.audit(row.id,'account.login');return this.newSession(row.id,row.password_hash);
  }
  async newSession(id:string,expectedHash?:string){
    const session=token(),csrf=token(),tx=await this.pool.connect();
    try{await tx.query('begin');const account=(await tx.query('select a.password_hash,m.active from factory.accounts a join public.memberships m on m.user_id=a.id where a.id=$1 for update of a,m',[id])).rows[0];
      if(!account?.active||expectedHash&&account.password_hash!==expectedHash)throw new AppError('UNAUTHENTICATED','Доступ изменился. Войдите заново.');
      await tx.query("insert into factory.sessions values($1,$2,$3,now()+interval '12 hours')",[tokenHash(session),id,csrf]);await tx.query('commit');
    }catch(e){await tx.query('rollback');throw e;}finally{tx.release();}
    return {token:session,csrf,userId:id};
  }
  async session(raw:string){
    if(!/^[A-Za-z0-9_-]{43}$/.test(raw))return null;
    return (await this.pool.query('select s.user_id id,s.csrf,a.login from factory.sessions s join public.memberships m on m.user_id=s.user_id join factory.accounts a on a.id=s.user_id where s.hash=$1 and s.expires_at>now() and m.active',[tokenHash(raw)])).rows[0]??null;
  }
  async verifyUser(raw:string){const s=await this.session(raw);if(!s)throw new AppError('UNAUTHENTICATED','Войдите в систему.');return {userId:s.id as string,role:'admin' as const};}
  async verifyWorker(raw:string){const row=(await this.pool.query('select id from private.workers where token_hash=$1 and revoked_at is null',[tokenHash(raw)])).rows[0];if(!row)throw new AppError('UNAUTHENTICATED','Недействительный исполнитель.');return {workerId:row.id as string};}
  async checkInvite(code:unknown){
    if(typeof code!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(code))throw new AppError('FORBIDDEN','Ключ регистрации недействителен, уже использован или истёк.');
    const row=(await this.pool.query('select login,expires_at from factory.invites where hash=$1 and used_at is null and expires_at>now()',[tokenHash(code)])).rows[0];
    if(!row)throw new AppError('FORBIDDEN','Ключ регистрации недействителен, уже использован или истёк.');
    return {valid:true,login:row.login,expiresAt:new Date(row.expires_at).toISOString()};
  }
  async invite(actor:string,login?:unknown){
    const value=login?loginInput(login):null,code=token();
    const row=(await this.pool.query("insert into factory.invites(hash,login,expires_at,created_by) values($1,$2,now()+interval '20 minutes',$3) returning expires_at",[tokenHash(code),value,actor])).rows[0];
    await this.audit(actor,'invitation.create');return {code,expiresInMinutes:20,expiresAt:new Date(row.expires_at).toISOString()};
  }
  async logout(raw:string){await this.pool.query('delete from factory.sessions where hash=$1',[tokenHash(raw)]);}
  async sessions(raw:string){
    const user=await this.verifyUser(raw);
    return (await this.pool.query('select hash as id,expires_at,hash=$2 as current from factory.sessions where user_id=$1 and expires_at>now() order by expires_at desc',[user.userId,tokenHash(raw)])).rows;
  }
  async revokeOtherSessions(raw:string){
    const user=await this.verifyUser(raw);
    await this.pool.query('delete from factory.sessions where user_id=$1 and hash<>$2',[user.userId,tokenHash(raw)]);
    await this.audit(user.userId,'account.sessions.revoke');
  }
  async changePassword(raw:string,current:unknown,next:unknown){
    const user=await this.verifyUser(raw);
    await this.limit('password:'+user.userId,5);
    if(typeof current!=='string'||typeof next!=='string')throw new AppError('INVALID_INPUT','Укажите текущий и новый пароль.');
    if(this.hashing>=2)throw new AppError('UNAVAILABLE','Повторите через несколько секунд.');
    this.hashing++;
    try{
      const old=(await this.pool.query('select password_hash from factory.accounts where id=$1',[user.userId])).rows[0]?.password_hash;
      if(!old||!await passwordMatches(current,old))throw new AppError('UNAUTHENTICATED','Текущий пароль неверен.');
      const hash=await passwordHash(next),tx=await this.pool.connect();
      try{
        await tx.query('begin');
        const changed=await tx.query('update factory.accounts set password_hash=$2 where id=$1 and password_hash=$3',[user.userId,hash,old]);
        if(!changed.rowCount)throw new AppError('CONFLICT','Пароль уже изменён. Войдите заново.');
        await tx.query('delete from factory.sessions where user_id=$1 and hash<>$2',[user.userId,tokenHash(raw)]);
        await tx.query("insert into factory.audit(actor,action) values($1,'account.password.change')",[user.userId]);
        await tx.query('commit');
      }catch(e){await tx.query('rollback');throw e;}finally{tx.release();}
    }finally{this.hashing--;}
  }
}
