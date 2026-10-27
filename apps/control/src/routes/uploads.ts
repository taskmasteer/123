import {object,uuid,leaseDto} from '../../../../packages/contracts/src/http.js';
import {prepareInput} from '../../../../packages/adapters/src/r2-store.js';
import type {R2Store} from '../../../../packages/adapters/src/r2-store.js';
import {unavailable} from '../errors.js';
export async function uploadsRoute(store:R2Store|undefined,workerId:string,path:string,body:unknown){if(!store?.authority)return unavailable();if(path==='/uploads/prepare')return store.prepare(workerId,prepareInput(body));if(path==='/uploads/complete'){const p=object(body,['uploadId','lease']);return store.complete(workerId,uuid(p.uploadId),leaseDto(p.lease));}return unavailable();}
