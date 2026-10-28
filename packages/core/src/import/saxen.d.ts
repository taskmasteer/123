declare module 'saxen' {
 export class Parser {on(event:'openTag',callback:(name:string,attrs:()=>Record<string,string>)=>void):void;on(event:string,callback:(...args:unknown[])=>void):void;parse(xml:string):void}
}
