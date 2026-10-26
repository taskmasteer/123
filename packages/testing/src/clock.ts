import type { Clock } from '../../contracts/src/model.js';
export class ManualClock implements Clock {
  constructor(private time = 0) {}
  now(): number { return this.time; }
  advanceBy(milliseconds: number): void { this.time += milliseconds; }
}
