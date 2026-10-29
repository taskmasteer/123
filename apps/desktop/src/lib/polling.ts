/** Only active work schedules updates. Idle/hidden panels wait for an explicit wakeup. */
export function pollLoop(poll:()=>Promise<{active:boolean;key:string}>,visible=()=>true,events?:EventTarget,focusEvents=events){
 let stopped=false,busy=false,active=false,previous='',unchanged=0,timer:ReturnType<typeof setTimeout>;
 async function run(){
  if(stopped||busy||!visible())return;
  busy=true;let wait=60000;
  try{
   const next=await poll();active=next.active;
   unchanged=next.key===previous?unchanged+1:0;previous=next.key;
   wait=Math.min(60000,1500*2**Math.min(unchanged,6));
  }catch{wait=60000;}
  finally{busy=false;if(!stopped&&active&&visible())timer=setTimeout(()=>void run(),wait);}
 }
 const resume=()=>{clearTimeout(timer);if(visible())void run();};
 events?.addEventListener('visibilitychange',resume);focusEvents?.addEventListener('focus',resume);void run();
 return ()=>{stopped=true;clearTimeout(timer);events?.removeEventListener('visibilitychange',resume);focusEvents?.removeEventListener('focus',resume);};
}
