declare const nativePersistenceBrand: unique symbol;
export type NativePersistencePermit = {readonly [nativePersistenceBrand]:true};
const permits=new WeakSet<object>();
/** Internal bootstrap handoff only. Never serialize or expose through a request schema. */
export function nativePersistencePermit():NativePersistencePermit{const permit=Object.freeze({}) as NativePersistencePermit;permits.add(permit);return permit;}
export function isNativePersistencePermit(value:unknown):value is NativePersistencePermit{return !!value&&typeof value==='object'&&permits.has(value);}
