import {StatusBadge} from '../components/ui/status-badge.js';
import React,{useEffect,useState} from 'react';
import {Button} from '../components/ui/button.js';
import {api} from './client.js';
type Diagnostic={jobId:string;stage:string;code:string;title:string;message:string;action:string;retryable:boolean;issues:string[]};
export function JobProblem({siteId,state,checkpointId}:{siteId:string;state?:string|undefined;checkpointId?:string|null|undefined}){
 const [problem,setProblem]=useState<Diagnostic|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const visible=['needs_attention','waiting_provider','paused'].includes(state??'');
 useEffect(()=>{let active=true;setProblem(null);setError('');if(visible)void api<Diagnostic|null>('/api/sites/'+siteId+'/diagnostic').then(p=>{if(active)setProblem(p);}).catch(()=>{if(active)setError('Не удалось загрузить причину. Откройте сайт повторно.');});return()=>{active=false;};},[siteId,state,checkpointId,visible]);
 if(!visible)return null;
 return <div className="job-problem" role="status" style={{marginTop:12,padding:14,border:'1px solid var(--border)',borderRadius:10,maxWidth:640,whiteSpace:'normal'}}>{problem?<><StatusBadge state={state}>{problem.title}</StatusBadge><p>{problem.message}</p>{problem.issues.length?<ul>{problem.issues.map(i=><li key={i}>{i}</li>)}</ul>:null}<p>{problem.action}</p>{problem.retryable?<Button size="sm" variant="outline" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await api('/api/sites/'+siteId+'/jobs/retry',{});setProblem(null);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>{busy?'Возобновляем…':'Продолжить генерацию'}</Button>:null}<details><summary>Код для поддержки</summary><code>{problem.code} · {problem.stage} · {problem.jobId}</code></details></>:<p>{error?'':'Загрузка причины…'}</p>}{error?<p role="alert">{error}</p>:null}</div>;
}
