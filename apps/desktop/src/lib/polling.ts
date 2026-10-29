/** Bounded active updates; unchanged work backs off to a minute. Hidden clients make no requests. */
export function pollLoop(poll:()=>Promise<{active:boolean;key:string}>,visible=()=>true,events?:EventTarget){
 let stopped=false,busy=false,previous='',unchanged=0,timer:ReturnType<typeof setTimeout>;
 async function run(){
  if(stopped||busy)return;busy=true;let wait=60000;
  try{if(visible()){const next=await poll();unchanged=next.key===previous?unchanged+1:0;previous=next.key;wait=next.active?Math.min(60000,1500*2**Math.min(unchanged,6)):60000;}}
  catch{wait=60000;}finally{busy=false;if(!stopped)timer=setTimeout(()=>void run(),wait);}
 }
 const resume=()=>{if(visible()){clearTimeout(timer);void run();}};
 events?.addEventListener('visibilitychange',resume);void run();
 return ()=>{stopped=true;clearTimeout(timer);events?.removeEventListener('visibilitychange',resume);};
}
