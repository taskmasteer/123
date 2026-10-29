import {AppError,type Job} from '../../contracts/src/model.js';
export interface DirectionStyle {id:string;version:string;enabled:boolean;referenceIds:string[]}
export function batchDirection(styles:DirectionStyle[],batchId:string,rowNumber:number,referenceId?:string):NonNullable<Job['generation']> {
 let seed=2166136261;for(const char of batchId)seed=Math.imul(seed^char.charCodeAt(0),16777619);seed>>>=0;
 const enabled=styles.filter(s=>s.enabled&&(!referenceId||s.id===referenceId||s.referenceIds.includes(referenceId))).sort((a,b)=>a.id.localeCompare(b.id,'en'));
 if(!enabled.length)throw new AppError('NOT_FOUND','Нет доступного направления оформления.');
 const position=rowNumber-2,style=enabled[(seed%enabled.length+position)%enabled.length]!;
 return {seed:(seed+position)>>>0,styleId:style.id,templateVersion:style.version};
}
