import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import https from 'node:https';

export function probeApi(config){
 return new Promise(resolve=>{
  const origin=new URL(config.publicOrigin);
  const req=https.request({hostname:'127.0.0.1',port:config.tlsPort,path:'/health/live',ca:config.certificate,headers:{host:origin.host}},res=>{res.resume();resolve(res.statusCode===200);});
  const timer=setTimeout(()=>req.destroy(),5000);req.on('close',()=>clearTimeout(timer));req.on('error',()=>resolve(false));req.end();
 });
}
/** Out-of-process check also detects a blocked event loop, unlike an API timer. */
export async function superviseApi(root,data){
 let stopping=false,child=null;
 const stop=()=>{stopping=true;child?.kill('SIGTERM');};
 process.on('SIGINT',stop);process.on('SIGTERM',stop);
 try{
  while(!stopping){
   const config=JSON.parse(await readFile(join(data,'config.json'),'utf8'));
   child=spawn(process.execPath,[join(root,'scripts/server-manage.mjs'),'run-api','--log'],{cwd:root,stdio:['inherit','inherit','inherit','ipc'],windowsHide:true});
   let failures=0,checking=false,force;const started=Date.now();
   const timer=setInterval(async()=>{
    if(checking||stopping||Date.now()-started<90000)return;checking=true;
    try{failures=await probeApi(config)?0:failures+1;if(failures>=3){console.error(new Date().toISOString(),'api.watchdog.restart');const failedChild=child;failedChild?.kill('SIGTERM');force??=setTimeout(()=>failedChild?.kill('SIGKILL'),15000);force.unref();}}
    finally{checking=false;}
   },30000);timer.unref();
   await new Promise(resolve=>{child.once('error',resolve);child.once('exit',resolve);});clearInterval(timer);if(force)clearTimeout(force);child=null;
   if(!stopping)await new Promise(resolve=>setTimeout(resolve,5000));
  }
 }finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
