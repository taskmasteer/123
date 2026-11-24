import {verify} from 'node:crypto';
export function releasePayload(value){
 if(value.protocol!==1||!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value.version)||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.size)||value.size<1||value.size>512*1024*1024||!Number.isFinite(Date.parse(value.publishedAt)))throw Error('Invalid release metadata');
 return Buffer.from(JSON.stringify([value.protocol,value.version,value.size,value.sha256,value.publishedAt]));
}
export function verifyRelease(value,key){
 if(typeof value.signature!=='string'||!verify(null,releasePayload(value),key,Buffer.from(value.signature,'base64')))throw Error('Подпись обновления не подтверждена. Пакет не будет скачан.');
 return value;
}
