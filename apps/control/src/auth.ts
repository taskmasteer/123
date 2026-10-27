import {createHash} from 'node:crypto';
import {createRemoteJWKSet,jwtVerify} from 'jose';
import type {JWTVerifyGetKey} from 'jose';
import {AppError} from '../../../packages/contracts/src/model.js';
import type {Principal,Role} from '../../../packages/contracts/src/model.js';
export interface AuthOptions {
 issuer:string; audience:string; jwks?:JWTVerifyGetKey;
 membership(userId:string):Promise<Role|null>;
 worker(hash:string):Promise<{workerId:string}|null>;
}
export const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
export function createAuth(options:AuthOptions) {
 const keys=options.jwks??createRemoteJWKSet(new URL(options.issuer+'/.well-known/jwks.json'));
 return {
  async verifyUser(jwt:string):Promise<Principal>{
   let userId:string;
   try {
    const {payload}=await jwtVerify(jwt,keys,{issuer:options.issuer,audience:options.audience,algorithms:['RS256','ES256'],requiredClaims:['sub','exp','iat']});
    if(typeof payload.sub!=='string'||!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(payload.sub))throw new Error();
    userId=payload.sub;
   } catch { throw new AppError('UNAUTHENTICATED','Войдите в систему.'); }
   const role=await options.membership(userId);
   if(!role||!['user','spec-user','admin'].includes(role))throw new AppError('FORBIDDEN','Доступ к установке не предоставлен.');
   return {userId,role};
  },
  async verifyWorker(token:string){
   if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new AppError('UNAUTHENTICATED','Недействительное устройство.');
   const worker=await options.worker(tokenHash(token));
   if(!worker)throw new AppError('UNAUTHENTICATED','Недействительное устройство.'); return worker;
  }
 };
}
export type Auth=ReturnType<typeof createAuth>;
