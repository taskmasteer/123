import React from 'react';
import {Check,Clock,LoaderCircle,Pause,AlertCircle,Minus} from 'lucide-react';
import {Badge} from './badge.js';

/** Shared status presentation; callers retain domain-specific Russian labels. */
export function StatusBadge({state,children}:{state?:string|null|undefined;children:React.ReactNode}){
 const failed=['failed','needs_attention','invalid','unavailable'].includes(state??'');
 const running=['running','active','uploading'].includes(state??'');
 const done=['ready','complete','completed','healthy','valid','enabled'].includes(state??'');
 const waiting=['queued','waiting','waiting_provider','stale','warning','reserved','draining'].includes(state??'');
 const Icon=failed?AlertCircle:running?LoaderCircle:done?Check:state==='paused'?Pause:waiting?Clock:Minus;
 return <Badge variant={failed?'destructive':done?'secondary':'outline'} className="max-w-full whitespace-normal text-left leading-5" data-tone={failed?'danger':done?'success':running?'info':state==='paused'?'purple':waiting?'warning':'neutral'} data-state={state??'unknown'}><Icon aria-hidden="true" data-icon="inline-start" className={running?'motion-safe:animate-spin':''}/>{children}</Badge>;
}
