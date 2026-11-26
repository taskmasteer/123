import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createDesktopRuntime } from '../../../apps/worker/src/desktop-runtime.js';
import { cleanDirectories, directory } from '../../../apps/worker/test/fixtures.js';
import { site as files, file } from '../../../apps/worker/test/fixtures.js';
import { createLocalState, createLocalEditingStore } from '../../adapters/src/local-state.js';
import { createLocalQueue } from '../../adapters/src/local-queue.js';
import { createLocalArtifacts } from '../../adapters/src/local-artifacts.js';
import { createLocalRevisions } from '../../adapters/src/local-revisions.js';
import { createCheckpointStore } from '../../../apps/worker/src/checkpoints.js';
import { createEditing } from '../src/editing.js';
import { runJob } from '../../../apps/worker/src/pipeline.js';
import { FakeModel } from '../../adapters/src/fake-model.js';
import { FakePublication } from '../../adapters/src/fake-publication.js';
import { validateStatic } from '../../../apps/worker/src/validation/static.js';
import { AppError } from '../../contracts/src/model.js';
import type { EditingStore } from '../../contracts/src/editing.js';
import type { ModelPort,ArtifactFile,ValidationReport } from '../../contracts/src/model.js';

afterEach(cleanDirectories);

test('edit refinement survives restart, accepts only a draft, publishes explicitly and preserves pointers on reject', async () => {
  const root = await directory();
  let runtime = await createDesktopRuntime(root, resolve('.'));
  const request = (method: string, params: unknown = {}): Promise<any> => runtime.request({ id: randomUUID(), version: 1, method, params });
  const wait = async (siteId: string) => expect.poll(async () => (await request('job.status', { siteId })).state, { timeout: 20000 }).toBe('completed');
  try {
    const { site: created } = await request('site.create', { domain: 'editing.test', about: 'Original heading' });
    await wait(created.id);
    const before = (await request('site.list')).items[0];
    const first = await request('edit.request', { siteId: before.id, instruction: 'First candidate heading', expectedRevision: before.revision });
    expect(first.kind).toBe('edit');
    expect(first.id).not.toBe(before.id);
    await expect(request('edit.request', { siteId: before.id, instruction: 'Overlapping edit', expectedRevision: before.revision })).rejects.toMatchObject({ code: 'CONFLICT' });
    await wait(before.id);
    let review = await request('edit.list', { siteId: before.id });
    expect(review.candidates[0]).toMatchObject({ status: 'ready', baseRevision: before.revision });
    const candidate = review.candidates[0];
    await expect(request('preview.screenshot', { siteId: before.id, revisionId: candidate.id, candidateId: randomUUID(), width: 375 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await request('site.list')).items[0]).toMatchObject({ draftId: before.draftId, publishedId: before.publishedId, revision: before.revision });
    await request('edit.request', { siteId: before.id, instruction: 'Refined candidate heading', expectedRevision: before.revision, candidateId: candidate.id });
    await wait(before.id);
    review = await request('edit.list', { siteId: before.id });
    const refined = review.candidates[1];
    expect(refined).toMatchObject({ baseRevision: before.revision, baseManifestId: candidate.manifestId, baseDraftId: before.publishedId });
    await request('edit.reject', { siteId: before.id, candidateId: candidate.id });
    expect((await request('preview.screenshot', { siteId: before.id, revisionId: candidate.id, candidateId: refined.id, width: 375 })).dataUrl.startsWith('data:image/png;')).toBe(true);
    const messages = await request('chat.list', { siteId: before.id });
    expect(messages.filter((m: any) => m.role === 'user').map((m: any) => m.text)).toEqual(['First candidate heading', 'Refined candidate heading']);
    await runtime.close();
    runtime = await createDesktopRuntime(root, resolve('.'));
    expect(await request('chat.list', { siteId: before.id })).toEqual(messages);
    const accepted = await request('edit.accept', { siteId: before.id, candidateId: refined.id, expectedRevision: before.revision });
    expect(accepted).toMatchObject({ draftId: refined.id, publishedId: before.publishedId, revision: before.revision + 1 });
    const published = await request('site.publish', { siteId: before.id, expectedRevision: accepted.revision });
    expect(published.publishedId).toBe(refined.id);
    await request('edit.request', { siteId: before.id, instruction: 'Discard this heading', expectedRevision: published.revision });
    await wait(before.id);
    const rejected = (await request('edit.list', { siteId: before.id })).candidates[2];
    await request('edit.reject', { siteId: before.id, candidateId: rejected.id });
    expect((await request('site.list')).items[0]).toMatchObject({ draftId: published.draftId, publishedId: published.publishedId, revision: published.revision });
    await expect(request('edit.accept', { siteId: before.id, candidateId: candidate.id, expectedRevision: before.revision })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await request('preview.screenshot', { siteId: before.id, revisionId: refined.id, width: 375 })).dataUrl).toMatch(/^data:image\/png;base64,/);
    await expect(request('preview.screenshot', { siteId: before.id, revisionId: rejected.id, width: 375 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  } finally { await runtime.close(); }
}, 90000);

const admin = { userId: 'admin', role: 'admin' } as const;
test.each(['before-CAS','after-CAS'] as const)('managed atomic visual receipt survives revoked ordinary journal guard %s',async(window)=>{
 const h=await harness();try{
  const {map}=await h.editor.visualMap(admin,h.before.id,1),patch={elementId:map.elements.find(e=>e.tag==='h1')!.elementId,text:'Atomic manual save'};
  const job=await h.editor.requestVisual(admin,h.before.id,1,patch,map.binding.mapId,'atomic-save');await h.run(new FakeModel(),async f=>validateStatic(f),false);
  let authorized=true,commits=0;const guarded:EditingStore={transaction(operation){if(!authorized)return Promise.reject(new AppError('FORBIDDEN','Ordinary admission revoked'));return h.deps.store.transaction(operation);}};
  const editor=createEditing({...h.deps,store:guarded,visualAcceptance:async(candidate)=>{
   commits++;let site=h.before;
   if(window==='after-CAS')site=await h.deps.sites.compareAndSet(h.before.id,1,{draftId:candidate.id});
   const completed=window==='after-CAS';candidate.status=completed?'accepted':'conflict';candidate.acceptance!.state=completed?'completed':'conflict';candidate.visualSave!.state=completed?'completed':'failed';
   await h.deps.store.transaction(state=>{state.candidates[state.candidates.findIndex(c=>c.id===candidate.id)]=structuredClone(candidate);return {value:state,result:undefined};});authorized=false;
   return completed?{state:'completed' as const,site,journalCommitted:true as const}:{state:'failed' as const,code:'FORBIDDEN' as const,message:'Denied before installation',journalCommitted:true as const};
  }});
  expect((await editor.visualStatus(admin,h.before.id,job.edit!.candidateId)).status).toBe(window==='after-CAS'?'completed':'failed');expect(commits).toBe(1);
  authorized=true;const reopened=createEditing({...h.deps,store:guarded});expect((await reopened.requestVisual(admin,h.before.id,1,patch,map.binding.mapId,'atomic-save')).id).toBe(job.id);
  expect((await reopened.visualStatus(admin,h.before.id,job.edit!.candidateId)).status).toBe(window==='after-CAS'?'completed':'failed');expect((await h.deps.sites.get(h.before.id))!.revision).toBe(window==='after-CAS'?2:1);
 }finally{await h.close();}
});
test.each(['validation','revocation','conflict'] as const)('visual %s failure preserves draft/public pointers and never requests AI repair',async(mode)=>{const h=await harness();try{
 const {map}=await h.editor.visualMap(admin,h.before.id,1);const job=await h.editor.requestVisual(admin,h.before.id,1,{elementId:map.elements.find(e=>e.tag==='h1')!.elementId,text:'Manual save'},map.binding.mapId,'failed-save');let calls=0;
 if(mode==='revocation')h.deps.visualCompareAndSet=async()=>{throw new AppError('FORBIDDEN','Access revoked');};
 await h.run({run:async()=>{calls++;throw new Error('No repair');}},async()=>{if(mode==='conflict')await h.deps.sites.compareAndSet(h.before.id,1,{domainStatus:'changed'});return mode==='validation'?{ok:false,issues:[{code:'readability',message:'Text unreadable'}],screenshotIds:[]}:{ok:true,issues:[],screenshotIds:[]};});
 const result=await h.editor.visualStatus(admin,h.before.id,job.edit!.candidateId);expect(result.status).toBe('failed');expect(result.error).toBeTruthy();expect(calls).toBe(0);expect(await h.deps.sites.get(h.before.id)).toMatchObject({draftId:h.before.draftId,publishedId:h.before.publishedId,revision:mode==='conflict'?2:1});
}finally{await h.close();}});
test('model-free local claim skips an older AI job and runs only the deterministic visual producer',async()=>{const h=await harness();try{
 const older=await h.deps.sites.create({domain:'older-ai.test'},admin);await h.deps.queue.enqueue({id:older.id,siteId:older.id,kind:'generate',stage:'brief',state:'queued',checkpointId:null,baseRevision:0});
 const {map}=await h.editor.visualMap(admin,h.before.id,1);const target=map.elements.find(e=>e.tag==='h1')!;const job=await h.editor.requestVisual(admin,h.before.id,1,{elementId:target.elementId,text:'Manual'},map.binding.mapId,'visual-only');
 const claim=await h.deps.queue.claim('visual-device','visual');expect(claim?.job.id).toBe(job.id);expect((await h.deps.queue.get(older.id))!.state).toBe('queued');
}finally{await h.close();}});
test('visual Save is durable/idempotent and installs once without ModelPort or publish; subsequent AI starts from saved text',async()=>{
 const h=await harness();try{
  const {map}=await h.editor.visualMap(admin,h.before.id,h.before.revision),target=map.elements.find(e=>e.tag==='h1')!;
  const patch={elementId:target.elementId,text:'Manual saved heading'};
  const job=await h.editor.requestVisual(admin,h.before.id,1,patch,map.binding.mapId,'save-once');
  expect((await h.editor.requestVisual(admin,h.before.id,1,patch,map.binding.mapId,'save-once')).id).toBe(job.id);
  h.reopen();expect((await h.editor.visualStatus(admin,h.before.id,job.edit!.candidateId)).status).toBe('queued');
  await h.run({run:async()=>{throw new Error('Visual producer must never call model');}});
  const result=await h.editor.visualStatus(admin,h.before.id,job.edit!.candidateId);expect(result.status).toBe('completed');
  const site=(await h.deps.sites.get(h.before.id))!;expect(site).toMatchObject({revision:2,draftId:result.revision!.id,publishedId:h.before.publishedId});
  expect((await h.editor.visualStatus(admin,h.before.id,job.edit!.candidateId)).revision).toEqual(result.revision);
  expect((await h.deps.sites.get(site.id))!.revision).toBe(2);
  await expect(h.editor.requestVisual(admin,site.id,1,{...patch,text:'Changed replay'},map.binding.mapId,'save-once')).rejects.toMatchObject({code:'CONFLICT'});
  await h.editor.requestEdit(admin,site.id,'Change structure',2);
  await h.run({run:async(_request,tools)=>{const source=await tools.read('index.html');expect(source).toContain('Manual saved heading');await tools.write('index.html',source.replace('<h1>','<section><h1>').replace('</h1>','</h1></section>'));return {summary:'Structure changed',inputTokens:0,outputTokens:0};}});
 }finally{await h.close();}
});
async function harness() {
  const root = await directory(), clock = { now: () => 1000 };
  const sites = await createLocalState(join(root, 'sites'), clock), queue = await createLocalQueue(root, clock);
  const artifacts = await createLocalArtifacts(join(root, 'artifacts'), clock), revisions = await createLocalRevisions(root);
  const checkpoints = await createCheckpointStore(join(root, 'checkpoints'), clock), store = await createLocalEditingStore(root);
  const created = await sites.create({ domain: 'manual.test' }, admin);
  const originalFiles = [...files('<h1>Original manual heading</h1><p>Manually written body must survive.</p>'), file('manual.js', 'document.documentElement.dataset.manual = "kept";')];
  const manifest = await artifacts.put(created.id, originalFiles, 'manual-v1'), revisionId = randomUUID();
  await revisions.put({ id: revisionId, siteId: created.id, parentId: null, manifestId: manifest.id, kind: 'published', createdAt: 1000 });
  const before = await sites.compareAndSet(created.id, 0, { publishedId: revisionId });
  const deps = { sites, queue, artifacts, revisions, checkpoints, store, clock, ids: { next: randomUUID }, publication: new FakePublication(),visualCompareAndSet:async(actorId:string,siteId:string,expected:number,draftId:string)=>{if(actorId!==admin.userId)throw new AppError('FORBIDDEN','Revoked');return sites.compareAndSet(siteId,expected,{draftId});} };
  let editor = createEditing(deps);
  async function run(model: ModelPort = new FakeModel(),validate:(files:ArtifactFile[])=>Promise<ValidationReport>=async files=>validateStatic(files),recover=true) {
    const claim = (await queue.claim('test-device'))!;
    expect(claim).not.toBeNull();
    await runJob(claim.job, claim.lease, { ...deps, model, templates: { async prepare() { throw new Error('Disabled catalog must not prevent editing existing files'); }, async load() { throw new Error('An edit must not regenerate a template'); } }, workspace: join(root, 'work'), validate }, new AbortController().signal);
    if(!recover)return deps.store.transaction(state=>({result:state.candidates.at(-1)!}));
    await editor.recover(before.id);
    return (await editor.list(admin, before.id)).candidates.at(-1)!;
  }
  return { root, before, deps, originalFiles, run, get editor() { return editor; }, reopen(storeOverride = store) { editor = createEditing({ ...deps, store: storeOverride }); return editor; }, async close() { await queue.close(); await sites.close(); } };
}

test('manual files and body survive literal demo edits and refinement reads the selected candidate manifest', async () => {
  const h = await harness();
  try {
    await h.editor.requestEdit(admin, h.before.id, 'First heading', h.before.revision);
    const first = await h.run();
    const refinedJob = await h.editor.requestEdit(admin, h.before.id, 'Final heading', h.before.revision, first.id);
    expect(refinedJob.edit?.baseManifestId).toBe(first.manifestId);
    const second = await h.run();
    const result = await h.deps.artifacts.read(second.manifestId!);
    expect(result.find(f => f.path === 'style.css')).toEqual(h.originalFiles.find(f => f.path === 'style.css'));
    expect(result.find(f => f.path === 'manual.js')).toEqual(h.originalFiles.find(f => f.path === 'manual.js'));
    expect(new TextDecoder().decode(result.find(f => f.path === 'index.html')!.bytes)).toContain('<h1>Final heading</h1><p>Manually written body must survive.</p>');
    expect(await h.deps.sites.get(h.before.id)).toEqual(h.before);
  } finally { await h.close(); }
});

test('long failure text is bounded without losing the pointer-preservation explanation', async () => {
  const h = await harness();
  try {
    await h.editor.requestEdit(admin, h.before.id, 'Long failure', 1);
    const candidate = await h.run({ async run() { throw new Error('Service unavailable. ' + 'More diagnostic detail. '.repeat(100)); } });
    expect(candidate.summary).toContain('Service unavailable.');
    expect(candidate.summary).toContain('…');
    expect(candidate.summary.length).toBeLessThanOrEqual(512);
    expect(candidate.summary.endsWith('Черновик и публикация сохранены.')).toBe(true);
  } finally { await h.close(); }
});

test('ordinary users cannot edit accept reject or publish; scoped spec-users can edit and foreign users cannot read chat', async () => {
  const h = await harness();
  try {
    const user = { userId: 'admin', role: 'user' } as const;
    const spec = { userId: 'admin', role: 'spec-user' } as const;
    await expect(h.editor.requestEdit(user, h.before.id, 'Denied', 1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await h.editor.requestEdit(spec, h.before.id, 'Allowed heading', 1); const candidate = await h.run();
    await expect(h.editor.acceptCandidate(user, h.before.id, candidate.id, 1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(h.editor.rejectCandidate(user, h.before.id, candidate.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(h.editor.publish(user, h.before.id, 1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(h.editor.getConversation({ userId: 'outsider', role: 'spec-user' }, h.before.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(h.editor.requestEdit({ userId: 'outsider', role: 'spec-user' }, h.before.id, 'Denied', 1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const accepted = await h.editor.acceptCandidate(spec, h.before.id, candidate.id, 1);
    expect(accepted.draftId).toBe(candidate.id);
  } finally { await h.close(); }
});

test('an edit failure changes neither pointer and rejection releases the site for a new edit', async () => {
  const h = await harness();
  try {
    await h.editor.requestEdit(admin, h.before.id, 'Fail this attempt', 1);
    const candidate = await h.run({ async run(_request, tools) { await tools.write('manual.js', 'throw new Error("partial");'); throw new Error('provider unavailable'); } });
    expect(candidate.status).toBe('failed');
    expect(candidate.summary).toContain('provider unavailable');
    expect(candidate.summary).toContain('Черновик и публикация сохранены.');
    const history = await h.editor.getConversation(admin, h.before.id);
    expect(history.at(-1)?.text).toBe(candidate.summary);
    const reopened = h.reopen(await createLocalEditingStore(h.root));
    expect((await reopened.list(admin, h.before.id)).candidates[0]?.summary).toBe(candidate.summary);
    expect(await reopened.getConversation(admin, h.before.id)).toEqual(history);
    expect(await h.deps.sites.get(h.before.id)).toEqual(h.before);
    await h.editor.rejectCandidate(admin, h.before.id, candidate.id);
    await h.editor.requestEdit(admin, h.before.id, 'Retry heading', 1);
    const retried = await h.run();
    expect((await h.deps.artifacts.read(retried.manifestId!)).find(f => f.path === 'manual.js')).toEqual(h.originalFiles.find(f => f.path === 'manual.js'));
  } finally { await h.close(); }
});

test('failed edit diagnostics redact credentials and private addresses before persisting bounded chat text', async () => {
  const h = await harness();
  try {
    await h.editor.requestEdit(admin, h.before.id, 'Fail safely', 1);
    const candidate = await h.run({ async run() {
      throw new Error('Provider refused request. Authorization: Bearer sk-proj-123456789012345678901234567890; api_key="private-key-value"; password=hunter-two; "Cookie": "session=private-cookie"; https://user:password@example.test/?token=private-query C:\\Users\\private\\credentials.json ' + 'x'.repeat(1000));
    } });
    expect(candidate.summary).toContain('Provider refused request.');
    expect(candidate.summary).toContain('[скрыто]');
    expect(candidate.summary).not.toMatch(/sk-proj-|1234567890|private-key-value|hunter-two|private-cookie|user:password|private-query|credentials\.json/);
    expect(candidate.summary.length).toBeLessThanOrEqual(512);
    expect((await h.editor.getConversation(admin, h.before.id)).at(-1)?.text).toBe(candidate.summary);
    expect(await h.deps.sites.get(h.before.id)).toEqual(h.before);
  } finally { await h.close(); }
});

test('validation failure diagnostics differ from model errors and survive reopening the editor', async () => {
  const h = await harness();
  try {
    await h.editor.requestEdit(admin, h.before.id, 'Invalid output', 1);
    const candidate = await h.run({ async run(_request, tools) {
      await tools.write('index.html', '<html><body><form><input name="email"></form></body></html>');
      return { summary: 'invalid output', inputTokens: 0, outputTokens: 0 };
    } });
    expect(candidate.status).toBe('failed');
    expect(candidate.summary).toContain('Validation failed after two repairs.');
    expect(candidate.summary).toContain('Черновик и публикация сохранены.');
    const reopened = h.reopen(await createLocalEditingStore(h.root));
    expect((await reopened.getConversation(admin, h.before.id)).at(-1)?.text).toBe(candidate.summary);
    expect(await h.deps.sites.get(h.before.id)).toEqual(h.before);
  } finally { await h.close(); }
},30000);

test.each(['Cookie', 'Set-Cookie', '"Cookie"'])('redacts every authentication cookie in a %s header before persisting chat', async header => {
  const h = await harness();
  try {
    await h.editor.requestEdit(admin, h.before.id, 'Cookie failure', 1);
    const candidate = await h.run({ async run() {
      throw new Error(`Provider refused request. ${header}: session=first-cookie; refresh_session=second-private-cookie; auth=third-private-cookie`);
    } });
    expect(candidate.summary).toContain('Provider refused request.');
    expect(candidate.summary).toContain('[скрыто]');
    expect(candidate.summary).not.toMatch(/first-cookie|second-private-cookie|third-private-cookie/);
    expect(candidate.summary).toContain('Черновик и публикация сохранены.');
    const reopened = h.reopen(await createLocalEditingStore(h.root));
    expect((await reopened.getConversation(admin, h.before.id)).at(-1)?.text).toBe(candidate.summary);
    expect(await h.deps.sites.get(h.before.id)).toEqual(h.before);
  } finally { await h.close(); }
});

test.each(['checkpoint', 'job', 'site', 'base'] as const)('does not expose a failed diagnostic with a foreign %s binding', async mismatch => {
  const h = await harness();
  try {
    await h.editor.requestEdit(admin, h.before.id, 'Bound failure', 1);
    const real = h.deps.checkpoints;
    const editor = createEditing({ ...h.deps, checkpoints: { ...real, async load(id) {
      const saved = await real.load(id);
      if (mismatch === 'checkpoint') saved.checkpoint.jobId = randomUUID();
      if (mismatch === 'job') saved.state.jobId = randomUUID();
      if (mismatch === 'site') saved.state.siteId = randomUUID();
      if (mismatch === 'base') saved.state.baseManifestId = randomUUID();
      saved.state.error = 'Foreign private diagnostic';
      return saved;
    } } });
    const claim = (await h.deps.queue.claim('test-device'))!;
    await runJob(claim.job, claim.lease, { ...h.deps, model: { async run() { throw new Error('original failure'); } }, templates: { async load() { throw new Error('unexpected template'); } }, workspace: join(h.root, 'work') }, new AbortController().signal);
    const candidate = (await editor.list(admin, h.before.id)).candidates[0]!;
    expect(candidate.status).toBe('failed');
    expect(candidate.summary).not.toContain('Foreign private diagnostic');
    expect((await editor.getConversation(admin, h.before.id)).at(-1)?.text).not.toContain('Foreign private diagnostic');
    expect(await h.deps.sites.get(h.before.id)).toEqual(h.before);
  } finally { await h.close(); }
});

test('a site change during generation retains a validated conflicted candidate without changing the new draft', async () => {
  const h = await harness();
  try {
    await h.editor.requestEdit(admin, h.before.id, 'Concurrent heading', 1);
    const newer = await h.deps.sites.compareAndSet(h.before.id, 1, { input: { domain: 'manual.test', about: 'New brief' } });
    const candidate = await h.run();
    expect(candidate.status).toBe('conflict');
    expect(candidate.validation?.ok).toBe(true);
    await expect(h.editor.acceptCandidate(admin, h.before.id, candidate.id, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await h.deps.sites.get(h.before.id)).toEqual(newer);
    expect((await h.deps.artifacts.read(candidate.manifestId!)).length).toBe(3);
    await h.editor.requestEdit(admin, h.before.id, 'Fresh current draft heading', 2);
    expect((await h.run()).status).toBe('ready');
  } finally { await h.close(); }
});

test('restart reconciles acceptance and publication after registry CAS succeeded but journal completion failed', async () => {
  const h = await harness();
  try {
    await h.editor.requestEdit(admin, h.before.id, 'Crash-safe heading', 1); const candidate = await h.run();
    for (const operation of ['acceptance', 'publication'] as const) {
      let injected = false;
      const faulty: EditingStore = { transaction(action) { return h.deps.store.transaction(async state => {
        const outcome = await action(state);
        if (!injected && outcome.value && (operation === 'acceptance' ? outcome.value.candidates.some(c => c.acceptance?.state === 'completed') : outcome.value.publications.some(p => p.state === 'completed'))) {
          injected = true; throw new Error('simulated journal write interruption');
        }
        return outcome;
      }); } };
      const editor = h.reopen(faulty);
      await expect(operation === 'acceptance' ? editor.acceptCandidate(admin, h.before.id, candidate.id, 1) : editor.publish(admin, h.before.id, 2)).rejects.toThrow('simulated journal write interruption');
      expect(injected).toBe(true);
      await h.reopen().recover(h.before.id);
      const site = await h.deps.sites.get(h.before.id);
      expect(site).toMatchObject({ draftId: candidate.id, publishedId: operation === 'acceptance' ? h.before.publishedId : candidate.id, revision: operation === 'acceptance' ? 2 : 3 });
    }
    const review = await h.editor.list(admin, h.before.id);
    expect(review.publication).toMatchObject({ state: 'completed', siteId: h.before.id, revisionId: candidate.id, manifestId: candidate.manifestId });
    expect((await h.editor.publish(admin, h.before.id, 2)).revision).toBe(3);
    expect((await h.editor.acceptCandidate(admin, h.before.id, candidate.id, 1)).revision).toBe(3);
  } finally { await h.close(); }
});

test('durable edit request recovers when queue enqueue failed before acknowledgement', async () => {
  const h = await harness();
  try {
    const interrupted = createEditing({ ...h.deps, queue: { ...h.deps.queue, async enqueue() { throw new Error('queue write interruption'); } } });
    await expect(interrupted.requestEdit(admin, h.before.id, 'Queued once', 1)).rejects.toThrow('queue write interruption');
    await h.reopen().recover(h.before.id);
    expect((await h.run()).status).toBe('ready');
    expect((await h.editor.getConversation(admin, h.before.id)).filter(m => m.role === 'user').map(m => m.text)).toEqual(['Queued once']);
  } finally { await h.close(); }
});

test('pending explicit publication blocks edits, survives restart, and a conflicting CAS preserves the candidate', async () => {
  const h = await harness();
  try {
    await h.editor.requestEdit(admin, h.before.id, 'Published later', 1); const candidate = await h.run();
    await h.editor.acceptCandidate(admin, h.before.id, candidate.id, 1);
    const waiting = createEditing({ ...h.deps, publication: { async advance() { return 'waiting_quota'; } } });
    await expect(waiting.publish(admin, h.before.id, 2)).rejects.toMatchObject({ code: 'PROVIDER_WAIT' });
    await expect(waiting.requestEdit(admin, h.before.id, 'Overlapping edit', 2)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await h.deps.sites.get(h.before.id))?.publishedId).toBe(h.before.publishedId);
    const conflicting = createEditing({ ...h.deps, sites: { ...h.deps.sites, async compareAndSet() { throw new AppError('CONFLICT', 'remote writer won'); }, async settlePublication() { throw new AppError('CONFLICT', 'remote writer won'); } } });
    await conflicting.recover(h.before.id);
    const state = await conflicting.list(admin, h.before.id);
    expect(state.publication?.state).toBe('conflict');
    expect(state.candidates[0]?.manifestId).toBe(candidate.manifestId);
    expect((await h.deps.sites.get(h.before.id))?.publishedId).toBe(h.before.publishedId);
  } finally { await h.close(); }
});

test('rejection recovers after its journal commit when cancelling the failed queue entry was interrupted', async () => {
  const h = await harness();
  try {
    await h.editor.requestEdit(admin, h.before.id, 'Failed candidate', 1);
    const candidate = await h.run({ async run() { throw new Error('provider failed'); } });
    const interrupted = createEditing({ ...h.deps, queue: { ...h.deps.queue, async cancel() { throw new Error('interrupted queue cancellation'); } } });
    await expect(interrupted.rejectCandidate(admin, h.before.id, candidate.id)).rejects.toThrow('interrupted queue cancellation');
    await h.reopen().recover(h.before.id);
    expect((await h.deps.queue.get(candidate.jobId))?.state).toBe('cancelled');
    expect(await h.deps.sites.get(h.before.id)).toEqual(h.before);
    await h.editor.requestEdit(admin, h.before.id, 'Next attempt', 1);
    expect((await h.run()).status).toBe('ready');
  } finally { await h.close(); }
});

test('closing during a running edit resumes its saved instruction without duplicating chat on restart', async () => {
  const root = await directory();
  let runtime = await createDesktopRuntime(root, resolve('.'));
  const request = (method: string, params: unknown = {}): Promise<any> => runtime.request({ id: randomUUID(), version: 1, method, params });
  try {
    const { site } = await request('site.create', { domain: 'resume-edit.test' });
    await expect.poll(async () => (await request('job.status', { siteId: site.id })).state, { timeout: 20000 }).toBe('completed');
    const before = (await request('site.list')).items[0];
    await request('edit.request', { siteId: site.id, instruction: 'Resume this heading', expectedRevision: before.revision });
    await runtime.close();
    runtime = await createDesktopRuntime(root, resolve('.'));
    await expect.poll(async () => (await request('job.status', { siteId: site.id })).state, { timeout: 20000 }).toBe('completed');
    expect((await request('edit.list', { siteId: site.id })).candidates[0].status).toBe('ready');
    expect((await request('chat.list', { siteId: site.id })).map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect((await request('site.list')).items[0]).toMatchObject({ draftId: before.draftId, publishedId: before.publishedId, revision: before.revision });
  } finally { await runtime.close(); }
}, 45000);
