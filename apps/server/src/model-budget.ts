import type {Pool} from 'pg';
import type {ModelPort} from '../../../packages/contracts/src/model.js';
import {AppError} from '../../../packages/contracts/src/model.js';
import {createDeepSeekModel} from '../../../packages/adapters/src/deepseek.js';

/** Reserve a conservative token ceiling before EACH billed request. Failed and
 * uncertain requests remain charged; a restart cannot reset the budget. */
export function budgetedModel(pool:Pool,key:string,limits={job:16000000,batch:4096000000},fetcher:typeof fetch=fetch):ModelPort{
 if(![limits.job,limits.batch].every(n=>Number.isSafeInteger(n)&&n>=32000&&n<=100000000000))throw new AppError('INVALID_INPUT','Некорректный серверный бюджет модели.');
 const base=createDeepSeekModel(key);
 return {...base,async run(request,tools,signal,hooks){
  const receipts=new WeakMap<Response,{scopes:string[];ceiling:number}>();
  const transport:typeof fetch=async(input,init)=>{
   const jobId=request.operationId?.slice(0,36);
   if(!jobId||!/^[a-f0-9-]{36}$/.test(jobId))throw new AppError('CONFLICT','Не определено задание для учёта генерации.');
   const ceiling=Buffer.byteLength(String(init?.body??''),'utf8')+16000;
   const scopes=await reserveModelBudget(pool,jobId,request.site.id,ceiling,limits,signal);
   const response=await fetcher(input,init);
   receipts.set(response,{scopes,ceiling});
   return response;
  };
  return createDeepSeekModel(key,transport,async(response,tokens)=>{
   const receipt=receipts.get(response);
   if(!receipt)return;
   receipts.delete(response);
   // Adjust this HTTP request only. Lock batch before job, as in admission.
   await pool.query(`with locked as materialized (
      select key from factory.model_budgets where key=any($1::text[]) order by key for update
    ) update factory.model_budgets b set reserved=reserved+$2::bigint from locked where b.key=locked.key`,
    [receipt.scopes,tokens-receipt.ceiling]);
  }).run(request,tools,signal,hooks);
 }};
}

export async function reserveModelBudget(pool:Pool,jobId:string,siteId:string,reserved:number,limits:{job:number;batch:number},signal:AbortSignal){
   const tx=await pool.connect();
   try{
    await tx.query('begin');
    const job=(await tx.query("select batch_id from private.jobs where id=$1 and site_id=$2 and data->>'state'='running'",[jobId,siteId])).rows[0];
    if(!job)throw new AppError('STALE_LEASE','Задание больше не выполняется.');
    const scopes:[string,number][]=[...(job.batch_id?[[`batch:${job.batch_id}`,limits.batch] as [string,number]]:[]),[`job:${jobId}`,limits.job]];
    for(const [scope,limit] of scopes){
     await tx.query('insert into factory.model_budgets(key,reserved) values($1,0) on conflict do nothing',[scope]);
     const row=(await tx.query('select reserved from factory.model_budgets where key=$1 for update',[scope])).rows[0];
     if(Number(row.reserved)+reserved>limit)throw new AppError('NEEDS_ATTENTION','Model token budget exhausted.');
     await tx.query('update factory.model_budgets set reserved=reserved+$2 where key=$1',[scope,reserved]);
    }
    signal.throwIfAborted();await tx.query('commit');
    return scopes.map(([scope])=>scope);
   }catch(e){await tx.query('rollback');throw e;}finally{tx.release();}
}
