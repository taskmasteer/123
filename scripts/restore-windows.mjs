// Invoked by restore-windows.ps1. Passwords arrive only on the private stdin pipe.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {restoreWindowsBackup} from '../dist/apps/server/src/recovery.js';
import {protectSecret} from '../dist/apps/server/src/secrets.js';
const root=resolve(import.meta.dirname,'..');
let raw='';for await(const part of process.stdin){raw+=part;if(raw.length>16384)throw Error('Input too large');}
try{
 const input=JSON.parse(raw),config=JSON.parse((await readFile(resolve(root,'.local-state/server/config.json'),'utf8')).replace(/^\uFEFF/,''));
 const result=await restoreWindowsBackup({root,archive:resolve(input.archive),destination:resolve(input.destination),database:input.database,password:input.password,connection:{host:'127.0.0.1',port:config.databasePort,user:'factory',password:await protectSecret(config.databasePassword,true)}});
 console.log(JSON.stringify(result));
}catch(error){console.error('Восстановление не выполнено. Проверьте ключ, целостность архива и новый пустой путь. Рабочая установка не заменялась.');process.exitCode=1;}
