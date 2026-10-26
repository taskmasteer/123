import { AppError } from '../../contracts/src/model.js';
import type { Revision, RevisionRepository } from '../../contracts/src/model.js';
import { record } from '../../contracts/src/inputs.js';
import { privateJson } from './private-json.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function parseRevision(value: unknown): Revision {
  if (!record(value) || typeof value.id !== 'string' || !uuid.test(value.id) || typeof value.siteId !== 'string' || !uuid.test(value.siteId) ||
      typeof value.manifestId !== 'string' || !uuid.test(value.manifestId) || (value.parentId !== null && (typeof value.parentId !== 'string' || !uuid.test(value.parentId))) ||
      !['draft', 'candidate', 'published'].includes(String(value.kind)) || !Number.isSafeInteger(value.createdAt)) throw new AppError('INVALID_INPUT', 'Invalid revision.');
  return { id: value.id, siteId: value.siteId, manifestId: value.manifestId, parentId: value.parentId as string | null, kind: value.kind as Revision['kind'], createdAt: value.createdAt as number };
}
/** Immutable local revision catalog. Site pointers always resolve through these records. */
export async function createLocalRevisions(directory: string): Promise<RevisionRepository> {
  const storage = await privateJson<Revision[]>(directory, 'revisions.json', [], (value) => {
    if (!Array.isArray(value)) throw new AppError('INVALID_INPUT', 'Invalid revision catalog.');
    const revisions = value.map(parseRevision);
    if (new Set(revisions.map((r) => r.id)).size !== revisions.length || revisions.some((r) => r.parentId !== null && !revisions.some((parent) => parent.id === r.parentId && parent.siteId === r.siteId))) throw new AppError('INVALID_INPUT', 'Invalid revision parent or duplicate revision.');
    return revisions;
  });
  return {
    async put(revision) {
      const next = parseRevision(revision);
      await storage.transaction((revisions) => {
        const existing = revisions.find((r) => r.id === next.id);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(next)) throw new AppError('CONFLICT', 'Revision records are immutable.');
          return { result: undefined };
        }
        if (next.parentId !== null && !revisions.some((r) => r.id === next.parentId && r.siteId === next.siteId)) throw new AppError('INVALID_INPUT', 'Revision parent must belong to the same site.');
        return { value: [...revisions, next], result: undefined };
      });
    },
    async get(id) {
      if (!uuid.test(id)) throw new AppError('INVALID_INPUT', 'Invalid revision ID.');
      return storage.transaction((revisions) => ({ result: revisions.find((revision) => revision.id === id) ?? null }));
    },
  };
}
