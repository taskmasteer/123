import {EntityDecoder,DecodingMode,htmlDecodeTree} from 'entities/decode';
import {AppError} from '../../../contracts/src/model.js';
/** Bound decoded CSS offsets back to the exact HTML lexical value, including entities and CRLF. */
export function attributeSpan(source:string,start:number,end:number) {
 const raw=source.slice(start,end),match=/^[^\t\n\f\r =]+[\t\n\f\r ]*=[\t\n\f\r ]*/.exec(raw);
 if(!match){
  if(!/^[^\t\n\f\r =]+$/.test(raw))throw new AppError('INVALID_INPUT','Атрибут не содержит однозначного значения.');
  return {start:end,end,decoded:'',offset:(index:number)=>{if(index!==0)throw new AppError('INVALID_INPUT','Нет диапазона значения.');return end;},encode:(text:string)=>`="${text.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}"`};
 }
 const quote=/^["']$/.test(raw[match[0].length]??'')?raw[match[0].length]!:'';
 const valueStart=start+match[0].length+(quote?1:0),valueEnd=end-(quote?1:0),value=source.slice(valueStart,valueEnd);
 let decoded='';const offsets=new Map<number,number>([[0,0]]);
 for(let i=0;i<value.length;){const at=i;let part:string;
  if(value[i]==='&'){
   let emitted='';const decoder=new EntityDecoder(htmlDecodeTree,cp=>{emitted+=String.fromCodePoint(cp);});decoder.startEntity(DecodingMode.Attribute);let length=decoder.write(value,i+1);if(length<0)length=decoder.end();
   if(length>0){part=emitted;i+=length;}else{part='&';i++;}
  }else if(value[i]==='\r'){part='\n';i+=value[i+1]==='\n'?2:1;}
  else{part=value[i]==='\0'?'\ufffd':value[i]!;i++;}
  offsets.set(decoded.length,at);decoded+=part;offsets.set(decoded.length,i);
 }
 const offset=(index:number)=>{const rawOffset=offsets.get(index);if(rawOffset===undefined)throw new AppError('INVALID_INPUT','Граница правки делит HTML-сущность.');return valueStart+rawOffset;};
 const encode=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(quote==='"'?/"/g:quote==="'"?/'/g:/[\t\n\f\r "'`=]/g,c=>`&#${c.charCodeAt(0)};`);
 return {start:valueStart,end:valueEnd,decoded,offset,encode};
}
