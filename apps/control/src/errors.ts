import {randomUUID} from 'node:crypto';
import {AppError} from '../../../packages/contracts/src/model.js';
const status={UNAUTHENTICATED:401,FORBIDDEN:403,NOT_FOUND:404,INVALID_INPUT:400,DUPLICATE_DOMAIN:409,CONFLICT:409,STALE_LEASE:409,UNAVAILABLE:503,PROVIDER_WAIT:503,NEEDS_ATTENTION:503};
export function json(value:unknown,status=200){return Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});}
export function errorResponse(error:unknown){const known=error instanceof AppError;return json({error:{code:known?error.code:'UNAVAILABLE',message:known?error.message:'Сервис временно недоступен.'},requestId:randomUUID()},known?status[error.code]:503);}
export function unavailable():never{throw new AppError('UNAVAILABLE','Эта функция управляемого режима ещё не подключена.');}
