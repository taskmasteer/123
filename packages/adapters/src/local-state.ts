import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AppError } from '../../contracts/src/model.js';
import type { Clock, Site, SiteRepository } from '../../contracts/src/model.js';
import { nonemptyString, parseSiteInput, parseSitePatch, record } from '../../contracts/src/inputs.js';
import { authorize } from '../../core/src/permissions.js';
import { normalizeDomain } from '../../core/src/sites.js';

export interface LocalState extends SiteRepository { close(): Promise<void> }
const activeDirectories = new Set<string>();
interface State { version: 1; savedAt: number; sites: Site[] }

function parseState(value: unknown): State {
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.savedAt) || !Array.isArray(value.sites)) {
    throw new AppError('INVALID_INPUT', 'Local state is corrupt or uses an unsupported format.');
  }
  const ids = new Set<string>(); const domains = new Set<string>();
  for (const candidate of value.sites) {
    if (!record(candidate) || !nonemptyString(candidate.id) || !nonemptyString(candidate.ownerId) ||
        typeof candidate.domain !== 'string' || normalizeDomain(candidate.domain) !== candidate.domain ||
        !Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 0 ||
        !Array.isArray(candidate.assignedUserIds) || !candidate.assignedUserIds.every(nonemptyString) ||
        (candidate.draftId !== null && !nonemptyString(candidate.draftId)) ||
        (candidate.publishedId !== null && !nonemptyString(candidate.publishedId)) ||
        !nonemptyString(candidate.generationStatus) || !nonemptyString(candidate.domainStatus) ||
        parseSiteInput(candidate.input).domain !== candidate.domain || ids.has(candidate.id) || domains.has(candidate.domain)) {
      throw new AppError('INVALID_INPUT', 'Local state contains an invalid or duplicate site.');
    }
    ids.add(candidate.id); domains.add(candidate.domain);
  }
  return value as unknown as State;
}

/** Demonstration adapter for one controlling process; not a distributed database.
 * get/compareAndSet are trusted repository primitives: request handlers authorize
 * the principal before using them. list and create receive and enforce a principal.
 */
export async function createLocalState(directory: string, clock: Clock): Promise<LocalState> {
  if (process.env.NODE_ENV === 'production') throw new AppError('FORBIDDEN', 'Local demo state is unavailable in production.');
  const root = resolve(directory); const key = process.platform === 'win32' ? root.toLowerCase() : root;
  if (activeDirectories.has(key)) throw new AppError('CONFLICT', 'Local state is already open in this process.');
  activeDirectories.add(key);
  const path = join(root, 'state.json');
  let state: State = { version: 1, savedAt: 0, sites: [] };
  try {
    await mkdir(root, { recursive: true });
    try { state = parseState(JSON.parse(await readFile(path, 'utf8')) as unknown); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw new AppError('INVALID_INPUT', 'Cannot read local state; the original file was preserved.', { cause: error });
      }
    }
  } catch (error) { activeDirectories.delete(key); throw error; }

  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  function run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (closed) return Promise.reject(new AppError('CONFLICT', 'Local state is closed.'));
    const result = tail.then(operation); tail = result.catch(() => undefined); return result;
  }
  async function save(sites: Site[]): Promise<void> {
    const savedAt = clock.now();
    if (!Number.isSafeInteger(savedAt)) throw new AppError('INVALID_INPUT', 'Clock must return integer UTC milliseconds.');
    const next: State = { version: 1, savedAt, sites };
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      state = next;
    } finally { await rm(temporary, { force: true }); }
  }

  return {
    create(input, principal) {
      return run(async () => {
        authorize(principal, 'site:create');
        const validated = parseSiteInput(input); const domain = normalizeDomain(validated.domain);
        if (state.sites.some((site) => site.domain === domain)) throw new AppError('DUPLICATE_DOMAIN', 'Domain is already registered.');
        const site: Site = {
          id: randomUUID(), domain, ownerId: principal.userId, assignedUserIds: [], input: { ...validated, domain },
          revision: 0, draftId: null, publishedId: null, generationStatus: 'queued', domainStatus: 'pending',
        };
        await save([...state.sites, site]); return structuredClone(site);
      });
    },
    get(id) { return run(() => structuredClone(state.sites.find((site) => site.id === id) ?? null)); },
    list(principal, cursor, limit = 100) {
      return run(() => {
        // Validate the principal even when the registry is empty.
        authorize(principal, 'site:create');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new AppError('INVALID_INPUT', 'Page limit must be between 1 and 1000.');
        const visible = state.sites.filter((site) => principal.role === 'admin' || site.ownerId === principal.userId || site.assignedUserIds.includes(principal.userId));
        const cursorIndex = cursor === undefined ? -1 : visible.findIndex((site) => site.id === cursor);
        if (cursor !== undefined && cursorIndex === -1) throw new AppError('INVALID_INPUT', 'Invalid site cursor.');
        const items = visible.slice(cursorIndex + 1, cursorIndex + 1 + limit);
        const nextCursor = cursorIndex + 1 + items.length < visible.length ? items.at(-1)!.id : null;
        return { items: structuredClone(items), nextCursor };
      });
    },
    compareAndSet(siteId, expectedRevision, patch) {
      return run(async () => {
        const site = state.sites.find((item) => item.id === siteId);
        if (!site) throw new AppError('NOT_FOUND', 'Site does not exist.');
        if (site.revision !== expectedRevision) throw new AppError('CONFLICT', 'Site revision has changed.');
        const validated = parseSitePatch(patch);
        if (validated.input) {
          validated.input.domain = normalizeDomain(validated.input.domain);
          if (validated.input.domain !== site.domain) throw new AppError('INVALID_INPUT', 'Site domain is immutable.');
        }
        const next = { ...site, ...validated, revision: site.revision + 1 };
        await save(state.sites.map((item) => item.id === siteId ? next : item)); return structuredClone(next);
      });
    },
    close() {
      closed = true;
      closing ??= tail.then(() => { activeDirectories.delete(key); });
      return closing;
    },
  };
}
