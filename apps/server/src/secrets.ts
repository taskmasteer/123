import { spawn } from 'node:child_process';
import {linuxSecretCodec} from './linux-secrets.js';
/** Windows DPAPI LocalMachine; plaintext is carried over private pipes, never argv/files. */
export async function protectSecret(value:string, decrypt=false):Promise<string>{
  if(process.platform==='linux'){
    const path=process.env.SITE_FACTORY_SECRET_KEY_FILE;
    if(!path)throw new Error('SITE_FACTORY_SECRET_KEY_FILE is required.');
    return linuxSecretCodec(path)(value,decrypt);
  }
  if(process.platform!=='win32')throw new Error('Supported server platforms: Windows and Linux.');
  const operation=decrypt?"$bytes=[Convert]::FromBase64String($inputValue); $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))":"$bytes=[Text.Encoding]::UTF8.GetBytes($inputValue); $encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine); [Console]::Out.Write([Convert]::ToBase64String($encrypted))";
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $inputValue=[Console]::In.ReadToEnd(); "+operation],{windowsHide:true,stdio:['pipe','pipe','ignore']});
    let result='';const timer=setTimeout(()=>{child.kill();reject(new Error('Secret protection timed out'));},15000);
    child.stdout.on('data',data=>{result+=data.toString();if(result.length>128000)child.kill();});child.on('error',()=>{clearTimeout(timer);reject(new Error('Secret protection unavailable'));});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(result):reject(new Error('Secret protection failed'));});child.stdin.end(value);
  });
}
