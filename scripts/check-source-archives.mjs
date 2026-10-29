import {argumentsFor,sourceLock} from './lib/package-stage.mjs';
import {verifiedArchive,extractZip,extractTarGz} from './lib/package-download.mjs';
import {targetInfo,checkArchitecture} from './lib/package-runtime.mjs';
import {resolve} from 'node:path';
try{
 const options=argumentsFor(),info=targetInfo(options.target),{lock}=await sourceLock(options),sources=lock.targets[options.target];
 const nodePrefix=info.nodeArchive.replace(/\.(zip|tar.gz)$/,''),nodeFile=nodePrefix+'/'+(info.os==='win32'?'node.exe':'bin/node');
 const results=[];
 for(const item of [{...sources.node,name:'node',cache:resolve('.local-state/runtime-cache',options.target,info.nodeArchive)},...sources.browsers.map(item=>({...item,cache:resolve('.local-state/runtime-cache',options.target,item.name+'-'+item.revision+'.zip')}))]){
  const path=await verifiedArchive(item,{offline:true}),files=new Set();let executables=0,notices=0;
  const onFile=({path,bytes,mode,kind})=>{
   files.add(path);if(kind!=='file')return;
   if(/(?:license|licence|copying|credits\.html|(?:^|\/)ABOUT$)/i.test(path)&&bytes.length)notices++;
   const magic=bytes.length>=4&&[0xfeedfacf,0xcafebabe,0xcafebabf].some(m=>bytes.readUInt32LE(0)===m||bytes.readUInt32BE(0)===m);
   if(bytes.subarray(0,2).toString()==='MZ'||magic){checkArchitecture(bytes.subarray(0,65536),options.target);const launchable=path===nodeFile||path===info.chrome||path===info.shell||bytes.length>=16&&bytes.readUInt32LE(0)===0xfeedfacf&&bytes.readUInt32LE(12)===2;if(info.os==='darwin'&&launchable&&!(mode&0o111))throw Error('Missing executable archive mode: '+path);executables++;}
  };
  if(path.endsWith('.zip'))await extractZip(path,undefined,{onFile});else await extractTarGz(path,undefined,{onFile,select:new Set([nodeFile,nodePrefix+'/LICENSE'])});
  const required=item.name==='node'?nodeFile:item.name==='chromium'?info.chrome:item.name==='chromium-headless-shell'?info.shell:undefined;
  if(required&&!files.has(required)||!executables)throw Error('Missing target executable in '+item.name);
  if(['node','chromium','chromium-headless-shell','ffmpeg'].includes(item.name)&&!notices)throw Error('Missing distribution notices: '+item.name);
  results.push({name:item.name,sha256:item.sha256,entries:files.size,executables,notices});
 }
 console.log(JSON.stringify({target:options.target,archiveChecks:results,extractedLayout:false,platformExecution:false}));
}catch(error){console.error(error.stack??error.message);process.exitCode=1;}
