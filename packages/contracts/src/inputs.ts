import { AppError } from './model.js';
import type { SiteInput, SitePatch } from './model.js';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
export function parseSiteInput(value: unknown): SiteInput {
  if (!record(value) || !nonemptyString(value.domain) ||
      Object.keys(value).some((key) => !['domain', 'about', 'referenceId', 'logoAssetId'].includes(key)) ||
      ['about', 'referenceId', 'logoAssetId'].some((key) => key in value && typeof value[key] !== 'string')) {
    throw new AppError('INVALID_INPUT', 'Invalid site input.');
  }
  return structuredClone(value) as unknown as SiteInput;
}
export function parseSitePatch(value: unknown): SitePatch {
  const allowed = ['assignedUserIds', 'input', 'draftId', 'publishedId', 'generationStatus', 'domainStatus'];
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key)) ||
      ('assignedUserIds' in value && (!Array.isArray(value.assignedUserIds) || !value.assignedUserIds.every(nonemptyString))) ||
      ['draftId', 'publishedId'].some((key) => key in value && value[key] !== null && !nonemptyString(value[key])) ||
      ['generationStatus', 'domainStatus'].some((key) => key in value && !nonemptyString(value[key]))) {
    throw new AppError('INVALID_INPUT', 'Invalid site patch.');
  }
  if ('input' in value) parseSiteInput(value.input);
  return structuredClone(value) as SitePatch;
}
