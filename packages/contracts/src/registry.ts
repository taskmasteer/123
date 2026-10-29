import type {Job,Site} from './model.js';
export const registryErrors={validation_failed:'Страница не прошла проверку.',provider_wait:'Сервис временно недоступен. Повторите позже.',generation_failed:'Задание не завершено. Проверьте настройки и повторите.',publication_failed:'Публикация требует проверки.'} as const;
export interface RegistryDetails {topic:string|null;latestError:{code:keyof typeof registryErrors;message:string}|null}
export function safeTopic(value:unknown):string|null{
 if(typeof value!=='string'||!value.trim()||value==='Automatic topic pending'||/bearer\s|sk-[a-z0-9]|api[_ -]?key\s*[:=]|password\s*[:=]|secret\s*[:=]/i.test(value))return null;
 return value.replace(/[\x00-\x1f]/g,' ').trim().slice(0,300);
}
export function registryProjection(site:Site,job:Job|null,state?:Record<string,unknown>):RegistryDetails{const topic=safeTopic(site.input.about?.trim()?site.input.about:state?.topic);
 let code:keyof typeof registryErrors|null=null;
 if(job?.state==='waiting_provider')code='provider_wait';
 if(job?.state==='needs_attention')code=state?.diagnostic&&Object.hasOwn(registryErrors,String(state.diagnostic))?state.diagnostic as keyof typeof registryErrors:job.stage==='publication'?'publication_failed':job.stage==='validate'?'validation_failed':'generation_failed';
 return {topic,latestError:code?{code,message:registryErrors[code]}:null};}
