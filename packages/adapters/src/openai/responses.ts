import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '../../../contracts/src/model.js';
import type { ModelContinuation, ModelPort, ModelRequest } from '../../../contracts/src/model.js';
import { record } from '../../../contracts/src/inputs.js';
import { digest, executeCall, toolsSchema, validateContinuation } from './tool-loop.js';
export interface ResponsesConfig {
    apiKey: string;
    model: string;
    imageModel?: string;
}
export function validateModelConfig(config: ResponsesConfig) {
    if (typeof config.apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(config.apiKey) || !validModel(config.model) || (config.imageModel !== undefined && !validModel(config.imageModel)))
        throw new AppError('INVALID_INPUT', 'Explicit valid model identifiers and an API key are required.');
}
export function validModel(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value); }
export async function readProviderJson(response: Response, maxBytes = 1000000): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader)
        throw new AppError('NEEDS_ATTENTION', 'Empty provider response.');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            length += value.byteLength;
            if (length > maxBytes) {
                await reader.cancel();
                throw new AppError('NEEDS_ATTENTION', 'Provider response exceeds the size limit.');
            }
            chunks.push(value);
        }
    }
    catch (error) {
        if (error instanceof AppError)
            throw error;
        throw new AppError('NEEDS_ATTENTION', 'Provider response was interrupted.');
    }
    finally {
        reader.releaseLock();
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new AppError('NEEDS_ATTENTION', 'Malformed provider response.');
    }
}
export function createResponsesModel(config: ResponsesConfig, transport: typeof fetch = fetch, timing = { now: Date.now, delay: (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }) }): ModelPort {
    validateModelConfig(config);
    const bindingFor=(request:ModelRequest,model:string)=>digest([request.operationId ?? request.site.id, request.mode, request.site.id, request.site.revision, request.baseManifestId, request.instruction, request.instructions, request.conversation, request.styleId, model]);
    const initialItems=(request:ModelRequest)=>[{type:'message',role:'user',content:JSON.stringify({domain:request.site.domain,about:request.site.input.about,conversation:request.conversation,instruction:request.instruction})}];
    function canRecover(value:unknown,diagnostic?:string):boolean {
        if(!record(value)||typeof value.binding!=='string')return false;
        let state:ModelContinuation;try{state=validateContinuation(value,value.binding);}catch{return false;}
        if(state.terminal!=='failed'||state.requestPending||state.transportExhausted)return false;
        const finished=new Set(state.items.filter(item=>item.type==='function_call_output').map(item=>item.call_id));
        if(state.items.some(item=>item.type==='function_call'&&!finished.has(item.call_id)))return false;
        // Exact legacy diagnostics allow existing a4af9de checkpoints to recover without reclassifying arbitrary failures.
        return state.recoverable==='account'||state.recoverable==='configuration'||diagnostic==='Provider quota requires account attention.'||
            /^Provider rejected the configured model request \(HTTP (400|401|402|403|404|422)\)\.$/.test(diagnostic??'');
    }
    return { retryOwner: 'adapter', identity: `openai:${config.model}`, canRecover,
        recover(request,previous,context){
            const previousModel=context.previousIdentity.startsWith('openai:')?context.previousIdentity.slice(7):'';
            if(!validModel(previousModel)||!canRecover(previous,context.diagnostic))throw new AppError('NEEDS_ATTENTION','This provider outcome cannot be restarted by account recovery.');
            const next=validateContinuation(previous,bindingFor(request,previousModel));
            next.binding=bindingFor({...request,operationId:context.operationId},config.model);next.terminal=null;delete next.recoverable;
            if(previousModel!==config.model){
                next.items=[...initialItems(request),{type:'message',role:'user',content:'Continue from the saved current files. Completed changes are already present. Inspect those files and preserve completed work; do not replay earlier mutations.'}];
                next.responseId=null;next.summary='';next.seen={};
            }
            return next;
        }, async run(request, tools, signal, hooks) {
            const binding = bindingFor(request,config.model);
            let state: ModelContinuation = request.continuation ? validateContinuation(request.continuation, binding) : {
                provider: 'openai-responses', version: 1, binding, items: [{ type: 'message', role: 'user', content: JSON.stringify({ domain: request.site.domain, about: request.site.input.about, conversation: request.conversation, instruction: request.instruction }) }], turns: 0, retries: 0, retryAt: 0, transportExhausted: false, requestPending: false, inputTokens: 0, outputTokens: 0, responseId: null, terminal: null, summary: '', seen: {}
            };
            function safe(value: unknown) { if (JSON.stringify(value).includes(config.apiKey))
                throw new AppError('NEEDS_ATTENTION', 'Sensitive provider content was blocked.'); }
            async function checkpoint() { safe(state); if (JSON.stringify(state).length > 1000000)
                throw new AppError('NEEDS_ATTENTION', 'Provider replay exceeded its private storage limit.'); await hooks?.checkpoint(structuredClone(state)); }
            async function terminal(kind: NonNullable<ModelContinuation['terminal']>): Promise<never> { state.terminal = kind; await checkpoint(); throw new AppError('NEEDS_ATTENTION', `Model response ${kind}.`); }
            async function retry(response?: Response) {
                state.requestPending = false;
                if (state.retries >= 3) {
                    state.transportExhausted = true;
                    await checkpoint();
                    throw new AppError('PROVIDER_WAIT', 'Model transport failed after three retries.');
                }
                const header = response?.headers.get('retry-after');
                const seconds = header && /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - timing.now() : 0;
                const delay = Math.max(Number.isFinite(seconds) ? seconds : 0, 1000 * 2 ** state.retries + Math.floor(Math.random() * 250));
                state.retries++;
                state.retryAt = timing.now() + delay;
                await checkpoint();
                if (delay > 30000)
                    throw new AppError('PROVIDER_WAIT', 'Provider requested a longer wait. Retry later.');
                await timing.delay(delay, signal);
            }
            await checkpoint();
            if (state.requestPending) {
                signal.throwIfAborted();
                await retry();
            }
            while (true) {
                signal.throwIfAborted();
                if (state.terminal === 'final')
                    return { summary: state.summary, inputTokens: state.inputTokens, outputTokens: state.outputTokens, ...(state.responseId ? { providerResponseId: state.responseId } : {}), continuation: state };
                if (state.terminal)
                    throw new AppError('NEEDS_ATTENTION', `Model response ${state.terminal}.`);
                if (state.transportExhausted)
                    throw new AppError('PROVIDER_WAIT', 'Model transport failed after three retries.');
                const finished = new Set(state.items.filter(item => item.type === 'function_call_output').map(item => item.call_id));
                for (const call of state.items.filter(item => item.type === 'function_call' && !finished.has(item.call_id))) {
                    const output = await executeCall(call, tools, state, signal);
                    safe(output);
                    state.items.push(output);
                    await checkpoint();
                }
                if (state.turns >= 48)
                    await terminal('stalled');
                const remaining = state.retryAt - timing.now();
                if (remaining > 30000)
                    throw new AppError('PROVIDER_WAIT', 'Provider requested a longer wait. Retry later.');
                if (remaining > 0)
                    await timing.delay(remaining, signal);
                signal.throwIfAborted();
                const body = { model: config.model, store: false, instructions: request.instructions ?? 'Modify local static website files using the tools. Keep website content in English. Preserve unrelated manual edits. No external requests, frameworks, forms or secrets.', input: state.items, tools: toolsSchema, parallel_tool_calls: false };
                safe(body);
                state.requestPending = true;
                await checkpoint();
                signal.throwIfAborted();
                let response: Response;
                try {
                    response = await transport('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
                }
                catch {
                    signal.throwIfAborted();
                    await retry();
                    continue;
                }
                if (!response.ok) {
                    let code = '';
                    try {
                        const error = await readProviderJson(response);
                        if (record(error) && record(error.error))
                            code = String(error.error.code ?? error.error.type ?? '');
                    }
                    catch { }
                    if (response.status === 429 && /quota|billing|usage_limit|spend_limit/.test(code)) {
                        state.requestPending = false;
                        state.terminal = 'failed';
                        state.recoverable='account';
                        await checkpoint();
                        throw new AppError('NEEDS_ATTENTION', 'Provider quota requires account attention.');
                    }
                    if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
                        await retry(response);
                        continue;
                    }
                    state.requestPending = false;
                    state.terminal = 'failed';
                    if([401,402,403].includes(response.status))state.recoverable='account';
                    else if([400,404,422].includes(response.status))state.recoverable='configuration';
                    await checkpoint();
                    throw new AppError('NEEDS_ATTENTION', `Provider rejected the configured model request (HTTP ${response.status}).`);
                }
                const data = await readProviderJson(response);
                safe(data);
                if (!record(data) || !Array.isArray(data.output) || !data.output.every(record))
                    throw new AppError('NEEDS_ATTENTION', 'Malformed provider response.');
                state.turns++;
                state.retryAt = 0;
                state.requestPending = false;
                state.items.push(...data.output);
                state.responseId = typeof data.id === 'string' ? data.id : null;
                if (record(data.usage))
                    for (const [source, target] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens']] as const) {
                        const count = data.usage[source];
                        if (!Number.isSafeInteger(count) || (count as number) < 0)
                            throw new AppError('NEEDS_ATTENTION', 'Invalid provider usage.');
                        state[target] += count as number;
                    }
                const content = data.output.flatMap(item => item.type === 'message' && Array.isArray(item.content) ? item.content : []);
                // Save the full ordered output BEFORE executing any tools, including opaque reasoning and phase.
                if(data.error!==undefined&&data.error!==null)await terminal('failed');
                if (content.some(item => record(item) && item.type === 'refusal'))
                    await terminal('refused');
                if (data.status !== 'completed')
                    await terminal(data.status === 'incomplete' ? 'incomplete' : data.status === 'cancelled' ? 'cancelled' : 'failed');
                if (!data.output.some(item => item.type === 'function_call')) {
                    const final = data.output.filter(item => item.type === 'message' && item.role === 'assistant' && item.phase !== 'commentary' && Array.isArray(item.content));
                    state.summary = final.flatMap(item => (item.content as unknown[]).flatMap(part => record(part) && part.type === 'output_text' && typeof part.text === 'string' ? [part.text] : [])).join('\n').slice(0, 8000);
                    if (state.summary.trim())
                        state.terminal = 'final';
                }
                await checkpoint();
                state = validateContinuation(state, binding);
            }
        } };
}
