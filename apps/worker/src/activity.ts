import type { ActivitySegment } from '../../../packages/contracts/src/monitoring.js';
/** Partial attempt execution, not CPU/billed/elapsed time. Overlong/unsealed gaps are lost. */
export class ActivityTimer {
    private at: number;
    private accrued = 0;
    private paused = 0;
    private sequence = 0;
    private pending: ActivitySegment | undefined;
    private work = Promise.resolve();
    constructor(readonly record: ((segment: ActivitySegment) => Promise<void>) | undefined, readonly now = () => performance.now()) { this.at = now(); }
    private capture() { const now = this.now(), delta = now - this.at; this.at = now; if (!this.paused && delta >= 0 && delta <= 45000)
        this.accrued += delta; }
    pause() { this.capture(); this.paused++; }
    resume() { this.at = this.now(); this.paused = Math.max(0, this.paused - 1); }
    flush() { this.capture(); const work = this.work.then(async () => { if (!this.record)
        return; this.pause(); try {
        if (!this.pending) {
            this.pending = { sequence: this.sequence + 1, durationMs: Math.min(45000, Math.floor(this.accrued)) };
            this.accrued = 0;
        }
        await this.record(this.pending);
        this.sequence = this.pending.sequence;
        this.pending = undefined;
    }
    finally {
        this.resume();
    } }); this.work = work.catch(() => { }); return work; }
    async wait<T>(action: () => Promise<T>): Promise<T> { this.pause(); try {
        return await action();
    }
    finally {
        this.resume();
    } }
    /** Atomically seal only if the existing queue transaction actually ends this lease. */
    boundary(action:(segment:ActivitySegment|undefined)=>Promise<boolean>):Promise<boolean>{
        const work=this.work.then(async()=>{this.pause();const existed=!!this.pending;try{
            if(this.record&&!this.pending){this.pending={sequence:this.sequence+1,durationMs:Math.min(45000,Math.floor(this.accrued))};this.accrued=0;}
            const segment=this.pending,ended=await action(segment);
            if(ended&&segment){this.sequence=segment.sequence;this.pending=undefined;}
            else if(!ended&&!existed&&segment){this.accrued+=segment.durationMs;this.pending=undefined;}
            return ended;
        }finally{this.resume();}});this.work=work.then(()=>{},()=>{});return work;
    }
}
