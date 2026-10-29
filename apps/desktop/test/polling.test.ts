import {test,expect,vi} from 'vitest';import {pollLoop} from '../src/lib/polling.js';
test('idle polling backs off, active changes update promptly, hidden panels stop requests and refresh on visibility',async()=>{
 vi.useFakeTimers();let active=false,key='idle',visible=true,calls=0;const events=new EventTarget(),stop=pollLoop(async()=>{calls++;return {active,key};},()=>visible,events);
 try{await vi.advanceTimersByTimeAsync(0);expect(calls).toBe(1);await vi.advanceTimersByTimeAsync(59000);expect(calls).toBe(1);active=true;key='running';await vi.advanceTimersByTimeAsync(1000);expect(calls).toBe(2);key='validate';await vi.advanceTimersByTimeAsync(1500);expect(calls).toBe(3);visible=false;await vi.advanceTimersByTimeAsync(120000);expect(calls).toBe(3);visible=true;events.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(0);expect(calls).toBe(4);}finally{stop();vi.useRealTimers();}
});
