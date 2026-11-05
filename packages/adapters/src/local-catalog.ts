import type { ArtifactFile, Job, Principal } from '../../contracts/src/model.js';
import { AppError } from '../../contracts/src/model.js';
import { join } from 'node:path';
import { record, nonemptyString } from '../../contracts/src/inputs.js';
import { authorize } from '../../core/src/permissions.js';
import { artifactMediaType, checkArtifacts } from '../../core/src/artifacts.js';
import { privateDirectory, readRegular, safeFile } from './safe-files.js';
import { privateJson } from './private-json.js';
export interface Reference { id: string; name: string; url: string; viewedAt: string; description: string; palette: string[]; typography: string; density: string; adaptations: string[] }
export interface Style { id: string; name: string; version: string; enabled: boolean; referenceIds: string[] }
export interface LocalCatalog {
  list(): Promise<{ styles: Style[]; references: Reference[] }>;
  prepare(job: Job, batchIndex: number, seed: number, referenceId?: string): Promise<Job>;
  load(styleId: string, version: string): Promise<ArtifactFile[]>;
  updateStyle(principal: Principal, id: string, enabled: boolean): Promise<void>;
  updateReference(principal: Principal, id: string, description: string): Promise<void>;
}
interface Template extends Style { files: string[] }
interface Overrides { version: 1; enabled: Record<string, boolean>; descriptions: Record<string, string> }
export async function createLocalCatalog(sourceRoot: string, privateRoot: string): Promise<LocalCatalog> {
  const templatesRoot = await privateDirectory(join(sourceRoot, 'templates'), false);
  const referencesRoot = await privateDirectory(join(sourceRoot, 'references'), false);
  async function json(root: string): Promise<unknown> { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readRegular(await safeFile(root, 'catalog.json'), 200_000))) as unknown; }
  const rawStyles = await json(templatesRoot); const rawReferences = await json(referencesRoot);
  if (!Array.isArray(rawStyles) || !rawStyles.every((s) => record(s) && typeof s.id === 'string' && /^[a-z][a-z-]+$/.test(s.id) && nonemptyString(s.name) &&
      typeof s.version === 'string' && /^\d+\.\d+\.\d+$/.test(s.version) && typeof s.enabled === 'boolean' && Array.isArray(s.referenceIds) && s.referenceIds.every(nonemptyString) &&
      Array.isArray(s.files) && s.files.every(nonemptyString)) || !Array.isArray(rawReferences) || !rawReferences.every((r) => record(r) && nonemptyString(r.id) &&
      nonemptyString(r.name) && typeof r.url === 'string' && r.url.startsWith('https://') && typeof r.viewedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.viewedAt) &&
      nonemptyString(r.description) && Array.isArray(r.palette) && r.palette.every(nonemptyString) && nonemptyString(r.typography) && nonemptyString(r.density) &&
      Array.isArray(r.adaptations) && r.adaptations.every(nonemptyString))) throw new AppError('INVALID_INPUT', 'Invalid style/reference catalog.');
  const styles = rawStyles as Template[]; const references = rawReferences as Reference[];
  if (new Set(styles.map((s) => s.id)).size !== styles.length || new Set(references.map((r) => r.id)).size !== references.length ||
      styles.some((s) => s.referenceIds.some((id) => !references.some((r) => r.id === id)))) throw new AppError('INVALID_INPUT', 'Duplicate or missing catalog identities.');
  const settings = await privateJson<Overrides>(privateRoot, 'catalog-overrides.json', { version: 1, enabled: {}, descriptions: {} }, (value) => {
    if (!record(value) || value.version !== 1 || !record(value.enabled) || !record(value.descriptions) ||
        Object.entries(value.enabled).some(([id, enabled]) => !styles.some((s) => s.id === id) || typeof enabled !== 'boolean') ||
        Object.entries(value.descriptions).some(([id, description]) => !references.some((r) => r.id === id) || !nonemptyString(description))) throw new AppError('INVALID_INPUT', 'Invalid catalog overrides.');
    return value as unknown as Overrides;
  });
  async function list() { return settings.transaction((value) => ({ result: {
    styles: styles.map(({ files: _files, ...style }) => ({ ...style, enabled: value.enabled[style.id] ?? style.enabled })),
    references: references.map((reference) => ({ ...reference, description: value.descriptions[reference.id] ?? reference.description })),
  } })); }
  return {
    list,
    async prepare(job, batchIndex, seed, referenceId) {
      if (job.generation) return structuredClone(job);
      if (!Number.isSafeInteger(batchIndex) || batchIndex < 0 || !Number.isSafeInteger(seed) || seed < 0) throw new AppError('INVALID_INPUT', 'Batch position and seed must be nonnegative integers.');
      const available = (await list()).styles.filter((style) => style.enabled && !style.id.startsWith('reference-') && (referenceId === undefined || style.id === referenceId || style.referenceIds.includes(referenceId)));
      if (!available.length) throw new AppError('NOT_FOUND', 'No enabled style matches the selected reference.');
      const selected = available[(batchIndex + seed % available.length) % available.length]!;
      return { ...structuredClone(job), generation: { seed: (seed + batchIndex) >>> 0, styleId: selected.id, templateVersion: selected.version } };
    },
    async load(styleId, version) {
      const style = styles.find((s) => s.id === styleId && s.version === version);
      if (!style) throw new AppError('NOT_FOUND', 'The pinned template version is unavailable.');
      const root = await privateDirectory(join(templatesRoot, style.id), false); const files: ArtifactFile[] = [];
      for (const path of style.files) {
        const mediaType = artifactMediaType(path);
        files.push({ path, mediaType, bytes: await readRegular(await safeFile(root, path), 2_000_000) });
      }
      checkArtifacts(files); return files;
    },
    async updateStyle(principal, id, enabled) {
      authorize(principal, 'admin:manage');
      if (typeof enabled !== 'boolean') throw new AppError('INVALID_INPUT', 'Enabled must be a boolean.');
      if (!styles.some((s) => s.id === id)) throw new AppError('NOT_FOUND', 'Style does not exist.');
      await settings.transaction((value) => { value.enabled[id] = enabled; return { value, result: undefined }; });
    },
    async updateReference(principal, id, description) {
      authorize(principal, 'admin:manage');
      if (typeof description !== 'string' || !description.trim() || description.length > 4000) throw new AppError('INVALID_INPUT', 'Reference description must contain 1–4000 characters.');
      if (!references.some((r) => r.id === id)) throw new AppError('NOT_FOUND', 'Reference does not exist.');
      await settings.transaction((value) => { value.descriptions[id] = description.trim(); return { value, result: undefined }; });
    },
  };
}
