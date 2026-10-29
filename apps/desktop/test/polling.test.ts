import {test,expect,vi} from 'vitest';
import {pollLoop} from '../src/lib/polling.js';

test('idle panels make no further calls over a day and resume on focus or visibility',async()=>{
 vi.useFakeTimers();let active=false,key='idle',visible=true,calls=0;const events=new EventTarget(),focusEvents=new EventTarget();
 const stop=pollLoop(async()=>{calls++;return {active,key};},()=>visible,events,focusEvents);
 try{
  await vi.advanceTimersByTimeAsync(0);expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(24*60*60*1000);expect(calls).toBe(1);expect(vi.getTimerCount()).toBe(0);
  active=true;key='queued';focusEvents.dispatchEvent(new Event('focus'));await vi.advanceTimersByTimeAsync(0);expect(calls).toBe(2);
  active=false;key='completed';await vi.advanceTimersByTimeAsync(1500);expect(calls).toBe(3);
  await vi.advanceTimersByTimeAsync(24*60*60*1000);expect(calls).toBe(3);
  visible=false;events.dispatchEvent(new Event('visibilitychange'));events.dispatchEvent(new Event('focus'));await vi.advanceTimersByTimeAsync(0);expect(calls).toBe(3);
  visible=true;events.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(0);expect(calls).toBe(4);
 }finally{stop();expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();}
});

test('active changes stay prompt, unchanged work backs off boundedly and hidden panels stop timers',async()=>{
 vi.useFakeTimers();let key='queued',visible=true;const at:number[]=[],events=new EventTarget();
 const stop=pollLoop(async()=>{at.push(Date.now());return {active:true,key};},()=>visible,events);
 try{
  await vi.advanceTimersByTimeAsync(0);await vi.advanceTimersByTimeAsync(1500);expect(at).toHaveLength(2);
  key='validate';await vi.advanceTimersByTimeAsync(2999);expect(at).toHaveLength(2);await vi.advanceTimersByTimeAsync(1);expect(at).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1500);expect(at).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(10*60*1000);const gaps=at.slice(1).map((time,i)=>time-at[i]!);expect(Math.max(...gaps)).toBe(60000);expect(at.length).toBeLessThan(20);
  visible=false;events.dispatchEvent(new Event('visibilitychange'));const before=at.length;await vi.advanceTimersByTimeAsync(24*60*60*1000);expect(at).toHaveLength(before);expect(vi.getTimerCount()).toBe(0);
  visible=true;events.dispatchEvent(new Event('focus'));await vi.advanceTimersByTimeAsync(0);expect(at).toHaveLength(before+1);
 }finally{stop();events.dispatchEvent(new Event('focus'));await vi.advanceTimersByTimeAsync(0);expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();}
});

test('a transient active failure retains bounded retry while initial idle failure stops',async()=>{
 vi.useFakeTimers();let calls=0;const stop=pollLoop(async()=>{calls++;if(calls===2)throw Error('offline');return {active:calls===1,key:String(calls)};});
 try{await vi.advanceTimersByTimeAsync(1500);expect(calls).toBe(2);await vi.advanceTimersByTimeAsync(60000);expect(calls).toBe(3);await vi.advanceTimersByTimeAsync(24*60*60*1000);expect(calls).toBe(3);}finally{stop();}
 const idleStop=pollLoop(async()=>{calls++;throw Error('offline');});try{await vi.advanceTimersByTimeAsync(24*60*60*1000);expect(calls).toBe(4);}finally{idleStop();vi.useRealTimers();}
});
