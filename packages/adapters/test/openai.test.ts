import { afterEach, expect, test, vi } from 'vitest';
import { createResponsesModel } from '../src/openai/responses.js';
import type { ModelRequest, ModelContinuation } from '../../contracts/src/model.js';
import { createFileTools } from '../../../apps/worker/src/files/tools.js';
import { cleanDirectories, directory } from '../../../apps/worker/test/fixtures.js';
afterEach(cleanDirectories);
afterEach(() => vi.useRealTimers());
test('rate_limit_exceeded is retryable and differs from exhausted quota',async()=>{
 const tools=await createFileTools(await directory());let now=1000;
 const f=fixtureTransport([new Response(JSON.stringify({error:{code:'rate_limit_exceeded'}}),{status:429}),{status:'completed',output:[final]}]);
 const result=await createResponsesModel({apiKey:secret,model:'configured-text'},f.transport,{now:()=>now,async delay(ms){now+=ms;}}).run(request,tools,new AbortController().signal);
 expect(result.summary).toBe('Changed the color.');expect(f.bodies).toHaveLength(2);
});
test('a response error cannot masquerade as a completed final answer',async()=>{
 const tools=await createFileTools(await directory());const f=fixtureTransport([{status:'completed',error:{code:'server_error'},output:[final]}]);
 await expect(createResponsesModel({apiKey:secret,model:'configured-text'},f.transport).run(request,tools,new AbortController().signal)).rejects.toThrow('failed');
});
export const request: ModelRequest = { mode: 'edit', site: { id: 'site', domain: 'signals.example', ownerId: 'owner', assignedUserIds: [], input: { domain: 'signals.example' }, revision: 2, draftId: 'draft', publishedId: null, generationStatus: 'completed', domainStatus: 'local' }, instruction: 'Change only the color to blue', baseManifestId: 'base', conversation: [], styleId: 'existing-site' };
const secret = 'synthetic-fixture-secret';
const final = { type: 'message', id: 'msg', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: 'Changed the color.', annotations: [] }] };
export function fixtureTransport(responses: unknown[]) {
    const bodies: Record<string, unknown>[] = [];
    const transport = (async (url, init) => { expect(String(url)).toBe('https://api.openai.com/v1/responses'); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + secret); bodies.push(JSON.parse(String(init?.body))); if (!responses.length)
        throw new Error('Unexpected HTTP call'); const response = responses.shift(); return response instanceof Response ? response : Response.json(response); }) as typeof fetch;
    return { bodies, transport };
}
test('replays full reasoning, phase and call_id while editing the immutable files only', async () => {
    const tools = await createFileTools(await directory());
    await tools.write('index.html', '<h1>Hand-written text</h1>');
    await tools.write('style.css', 'body{color:red}');
    const output = [{ type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'opaque' }, { type: 'message', id: 'progress', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'Changing color', annotations: [] }] }, { type: 'function_call', id: 'fc', call_id: 'call-color', name: 'replace', arguments: JSON.stringify({ path: 'style.css', oldText: 'red', newText: 'blue' }), status: 'completed' }];
    const f = fixtureTransport([{ id: 'r1', status: 'completed', output, usage: { input_tokens: 12, output_tokens: 4 } }, { id: 'r2', status: 'completed', output: [final], usage: { input_tokens: 20, output_tokens: 5 } }]);
    const result = await createResponsesModel({ apiKey: secret, model: 'configured-text' }, f.transport).run(request, tools, new AbortController().signal);
    expect(await tools.read('style.css')).toBe('body{color:blue}');
    expect(await tools.read('index.html')).toBe('<h1>Hand-written text</h1>');
    expect(f.bodies[1]!.input).toEqual(expect.arrayContaining([...output, { type: 'function_call_output', call_id: 'call-color', output: JSON.stringify({ ok: true }) }]));
    expect(result.summary).toBe('Changed the color.');
    expect(result.inputTokens).toBe(32);
    expect(result.outputTokens).toBe(9);
    expect(JSON.stringify(f.bodies)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(f.bodies[0]).toMatchObject({ model: 'configured-text', store: false, parallel_tool_calls: false });
});
test.each([
    ['refusal', { status: 'completed', output: [{ ...final, content: [{ type: 'refusal', refusal: 'Cannot comply.' }] }] }, 'refused'],
    ['incomplete', { status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } }, 'incomplete'],
    ['unknown tool', { status: 'completed', output: [{ type: 'function_call', call_id: 'bad', name: 'shell', arguments: '{}' }] }, 'tool'],
    ['quota', new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: secret } }), { status: 429 }), 'quota'],
] as const)('makes %s explicit without exposing provider bodies', async (_name, response, message) => {
    const f = fixtureTransport([response]);
    const tools = await createFileTools(await directory());
    await expect(createResponsesModel({ apiKey: secret, model: 'configured-text' }, f.transport).run(request, tools, new AbortController().signal)).rejects.toThrow(message);
    expect(f.bodies).toHaveLength(1);
});
test('resume preserves completed replace and rejects changed operation binding', async () => {
    const tools = await createFileTools(await directory());
    await tools.write('style.css', 'red');
    let saved: ModelContinuation | undefined;
    const call = { type: 'function_call', call_id: 'replace-once', name: 'replace', arguments: JSON.stringify({ path: 'style.css', oldText: 'red', newText: 'blue' }) };
    const first = fixtureTransport([{ status: 'completed', output: [call] }]);
    await expect(createResponsesModel({ apiKey: secret, model: 'configured-text' }, first.transport).run(request, tools, new AbortController().signal, { async checkpoint(state) { saved = state; if (state.items.some(item => item.type === 'function_call_output'))
            throw new Error('simulated restart'); } })).rejects.toThrow('simulated restart');
    const next = fixtureTransport([{ status: 'completed', output: [final] }]);
    await expect(createResponsesModel({ apiKey: secret, model: 'configured-text' }, next.transport).run({ ...request, continuation: saved! }, tools, new AbortController().signal)).resolves.toMatchObject({ summary: 'Changed the color.' });
    expect(await tools.read('style.css')).toBe('blue');
    expect(next.bodies).toHaveLength(1);
    await expect(createResponsesModel({ apiKey: secret, model: 'configured-text' }, next.transport).run({ ...request, instruction: 'different', continuation: saved! }, tools, new AbortController().signal)).rejects.toThrow('does not match');
});
test('network retries are capped across restart and never multiplied', async () => {
    const tools = await createFileTools(await directory());
    let saved: ModelContinuation | undefined;
    let now = 1000;
    const f = fixtureTransport(Array.from({ length: 4 }, () => new Response('{}', { status: 503 })));
    const model = createResponsesModel({ apiKey: secret, model: 'configured-text' }, f.transport, { now: () => now, async delay(ms) { now += ms; } });
    const result = expect(model.run(request, tools, new AbortController().signal, { async checkpoint(s) { saved = s; } })).rejects.toMatchObject({ code: 'PROVIDER_WAIT' });
    await result;
    expect(f.bodies).toHaveLength(4);
    const resume = expect(model.run({ ...request, continuation: saved! }, tools, new AbortController().signal)).rejects.toMatchObject({ code: 'PROVIDER_WAIT' });
    await resume;
    expect(f.bodies).toHaveLength(4);
});
test('cancellation interrupts backoff and Retry-After never retries early', async () => {
    const tools = await createFileTools(await directory());
    vi.useFakeTimers();
    const abort = new AbortController();
    const f = fixtureTransport([new Response('{}', { status: 429, headers: { 'retry-after': '20' } })]);
    const result = expect(createResponsesModel({ apiKey: secret, model: 'configured-text' }, f.transport).run(request, tools, abort.signal)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    abort.abort();
    await result;
    expect(f.bodies).toHaveLength(1);
});
test('long Retry-After is a durable wait and commentary never implies final', async () => {
    const tools = await createFileTools(await directory());
    let saved: ModelContinuation | undefined;
    const f = fixtureTransport([{ status: 'completed', output: [{ ...final, phase: 'commentary' }] }, new Response('{}', { status: 429, headers: { 'retry-after': '120' } })]);
    const model = createResponsesModel({ apiKey: secret, model: 'configured-text' }, f.transport);
    await expect(model.run(request, tools, new AbortController().signal, { async checkpoint(s) { saved = s; } })).rejects.toMatchObject({ code: 'PROVIDER_WAIT' });
    await expect(model.run({ ...request, continuation: saved! }, tools, new AbortController().signal)).rejects.toMatchObject({ code: 'PROVIDER_WAIT' });
    expect(f.bodies).toHaveLength(2);
});
test('stops repeated tool calls without file progress', async () => {
    const tools = await createFileTools(await directory());
    const f = fixtureTransport([1, 2, 3].map(n => ({ status: 'completed', output: [{ type: 'function_call', call_id: 'list' + n, name: 'list', arguments: '{}' }] })));
    await expect(createResponsesModel({ apiKey: secret, model: 'configured-text' }, f.transport).run(request, tools, new AbortController().signal)).rejects.toThrow('no progress');
    expect(f.bodies).toHaveLength(3);
});
test('an interrupted in-flight HTTP attempt consumes the same durable retry budget on restart', async () => {
    const tools = await createFileTools(await directory());
    let saved: ModelContinuation | undefined;
    let sends = 0, now = 1000;
    const controller = new AbortController();
    const transport = (async () => { sends++; controller.abort(); throw new Error('interrupted'); }) as typeof fetch;
    const model = createResponsesModel({ apiKey: secret, model: 'configured-text' }, transport, { now: () => now, async delay(ms) { now += ms; } });
    await expect(model.run(request, tools, controller.signal, { async checkpoint(s) { saved = s; } })).rejects.toThrow();
    expect(saved).toMatchObject({ requestPending: true });
    const resumed = fixtureTransport([{ status: 'completed', output: [final] }]);
    const result = await createResponsesModel({ apiKey: secret, model: 'configured-text' }, resumed.transport, { now: () => now, async delay(ms) { now += ms; } }).run({ ...request, continuation: saved! }, tools, new AbortController().signal);
    expect(result.continuation?.retries).toBe(1);
    expect(sends).toBe(1);
});
test('provider cannot persist a key it echoes in tool arguments', async () => {
    const tools = await createFileTools(await directory());
    const f = fixtureTransport([{ status: 'completed', output: [{ type: 'function_call', call_id: 'leak', name: 'write', arguments: JSON.stringify({ path: 'index.html', text: secret }) }] }]);
    const saved: unknown[] = [];
    await expect(createResponsesModel({ apiKey: secret, model: 'configured-text' }, f.transport).run(request, tools, new AbortController().signal, { async checkpoint(s) { saved.push(s); } })).rejects.toThrow('Sensitive');
    expect(await tools.list()).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain(secret);
});
