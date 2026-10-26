import type { PublicationPort } from '../../contracts/src/model.js';
import { AppError } from '../../contracts/src/model.js';
export class FakePublication implements PublicationPort {
  readonly runtimeStatus = { mode: 'demo', realHosting: false } as const;
  async advance(intentId: string) {
    if (typeof intentId !== 'string' || !intentId.trim()) throw new AppError('INVALID_INPUT', 'Publication intent is required.');
    return 'published' as const;
  }
}
