import { createHash } from 'node:crypto';
import { AppError } from '../../../contracts/src/model.js';
import type { FileTools, ModelContinuation } from '../../../contracts/src/model.js';
import { record } from '../../../contracts/src/inputs.js';
export const toolFields = { list: [], read: ['path'], write: ['path', 'text'], replace: ['path', 'oldText', 'newText'] } as const;
export const toolsSchema = Object.entries(toolFields).map(([name, fields]) => ({ type: 'function', name, strict: true,
    description: `${name} local static website files. Always include every required field, including path. Prefer small replace edits (under 6000 characters each) to rewriting large files.`, parameters: { type: 'object', properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])), required: fields, additionalProperties: false } }));
function callEnvelope(item:Record<string,unknown>,allowUnknown=false){
    if(typeof item.name!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(item.name)||(!allowUnknown&&!Object.hasOwn(toolFields,item.name))||typeof item.call_id!=='string'||!item.call_id||typeof item.arguments!=='string')throw new AppError('NEEDS_ATTENTION','Unsupported model tool call.');
}
export function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** Old read snapshots are redundant: workspace files are the source of truth.
 * Keep call/result identities and the newest read of each path for safe replay. */
export function compactReadHistory(state:ModelContinuation){
    if(JSON.stringify(state).length<700000)return;
    const completed=new Set(state.items.filter(i=>i.type==='function_call_output').map(i=>i.call_id));
    const latest=new Map<string,unknown>(),reads=new Map<unknown,string>();
    for(const item of state.items){
        if(item.type!=='function_call'||item.name!=='read'||!completed.has(item.call_id))continue;
        try{const call=parseCall(item);reads.set(item.call_id,call.args.path!);latest.set(call.args.path!,item.call_id);}catch{}
    }
    for(const item of state.items){
        const path=reads.get(item.call_id);
        if(item.type==='function_call_output'&&path&&latest.get(path)!==item.call_id)
            item.output=JSON.stringify({archived:true,message:'Older read snapshot omitted to keep context bounded. Current files and completed edits are preserved. Use the latest read result or read the current file if needed.'});
    }
}
export function parseCall(item: Record<string, unknown>) {
    if (typeof item.name !== 'string' || !Object.hasOwn(toolFields, item.name) || typeof item.call_id !== 'string' || !item.call_id || typeof item.arguments !== 'string')
        throw new AppError('NEEDS_ATTENTION', 'Unsupported model tool call.');
    let args: unknown;
    try {
        args = JSON.parse(item.arguments);
    }
    catch {
        throw new AppError('NEEDS_ATTENTION', 'Invalid model tool arguments.');
    }
    const fields = toolFields[item.name as keyof typeof toolFields] as readonly string[];
    if (!record(args) || Object.keys(args).length !== fields.length || fields.some(field => typeof args[field] !== 'string'))
        throw new AppError('NEEDS_ATTENTION', 'Invalid model tool arguments.');
    return { name: item.name, args: args as Record<string, string>, callId: item.call_id };
}
export async function executeCall(item: Record<string, unknown>, tools: FileTools, state: ModelContinuation, signal: AbortSignal) {
    signal.throwIfAborted();
    callEnvelope(item,state.provider==='deepseek-responses');
    if (!Object.hasOwn(toolFields,item.name as string)) {
        // Unknown calls have no filesystem capability. Keep their IDs for replay
        // so that the model can replace them with a supported operation.
        const signature=digest(['unsupported-tool']);
        state.seen[signature]=(state.seen[signature]??0)+1;
        if(state.seen[signature]!>3)throw new AppError('NEEDS_ATTENTION','Model repeatedly requested an unavailable tool.');
        return {type:'function_call_output',call_id:item.call_id,output:JSON.stringify({ok:false,error:'Unknown tool. No action was taken. Available tools: list, read, write, replace. Use replace for a small edit or write for a complete file.'})};
    }
    let parsed:ReturnType<typeof parseCall>;
    try{parsed=parseCall(item);}catch(error){
        if(!(error instanceof AppError)||error.message!=='Invalid model tool arguments.')throw error;
        const signature=digest(['invalid-arguments',item.name,item.arguments]);state.seen[signature]=(state.seen[signature]??0)+1;
        if(state.seen[signature]!>3)throw new AppError('NEEDS_ATTENTION','Model repeatedly returned invalid tool arguments.');
        return {type:'function_call_output',call_id:item.call_id,output:JSON.stringify({ok:false,error:`No operation was executed. Send valid JSON with ALL required string fields: ${toolFields[item.name as keyof typeof toolFields].join(', ')}. Include the file path in EVERY call. Do not omit fields or send a partial command. Keep edits small.`})};
    }
    const { name, args, callId } = parsed;
    const snapshot = [];
    const availablePaths = (await tools.list()).sort();
    for (const path of availablePaths)
        snapshot.push([path, await tools.read(path)]);
    const signature = digest([name, args, snapshot]);
    state.seen[signature] = (state.seen[signature] ?? 0) + 1;
    if (state.seen[signature]! > 2) {
        state.terminal = 'stalled';
        throw new AppError('NEEDS_ATTENTION', 'Model tool loop made no progress.');
    }
    let result: unknown;
    switch (name) {
        case 'list':
            result = await tools.list();
            break;
        case 'read':
        case 'replace':
            try {
                if (name === 'read') result = await tools.read(args.path!);
                else {
                    await tools.replace(args.path!, args.oldText!, args.newText!);
                    result = { ok: true };
                }
            } catch (error) {
                if (error instanceof AppError && error.code === 'INVALID_INPUT' && error.message === 'Replacement must match exactly once.') {
                    result = { ok: false, error: 'Replacement must match exactly once. No changes were made. Read the file again and copy a unique exact substring without extra escaping.' };
                } else if (!availablePaths.includes(args.path!) && (
                    (error instanceof AppError && error.code === 'INVALID_INPUT' && error.message === 'Only static site files are allowed.') ||
                    (error instanceof Error && 'code' in error && error.code === 'ENOENT')
                )) {
                    result = { ok: false, error: 'Unknown site file. No changes were made. Use an exact path from the current file list.', paths: availablePaths };
                } else throw error;
            }
            break;
        case 'write':
            try {
                await tools.write(args.path!, args.text!);
                result = { ok: true };
            } catch(error) {
                if (!(error instanceof AppError) || error.code !== 'INVALID_INPUT' || error.message !== 'Only static site files are allowed.') throw error;
                result = {ok:false,error:'File rejected; nothing was written. Only static website files are allowed: HTML, CSS, JavaScript, SVG and local image/font assets. Do not create Python, shell, JSON, Markdown or other helper files. No command execution is available. Continue editing the website files directly.'};
            }
            break;
    }
    return { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) };
}
export function validateContinuation(value: unknown, binding: string, provider: ModelContinuation['provider'] = 'openai-responses'): ModelContinuation {
    if (!record(value) || value.provider !== provider || value.version !== 1 || value.binding !== binding ||
        !Array.isArray(value.items) || value.items.length > 500 || !value.items.every(item => record(item) && typeof item.type === 'string') ||
        !['turns', 'retries', 'retryAt', 'inputTokens', 'outputTokens'].every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0) ||
        (value.turns as number) > 48 || (value.retries as number) > 3 || typeof value.transportExhausted !== 'boolean' || typeof value.requestPending !== 'boolean' || typeof value.summary !== 'string' ||
        (value.responseId !== null && typeof value.responseId !== 'string') || ![null, 'final', 'refused', 'incomplete', 'failed', 'cancelled', 'stalled'].includes(value.terminal as null) ||
        (value.recoverable!==undefined&&(!['account','configuration'].includes(String(value.recoverable))||value.terminal!=='failed'))||
        (value.retryCycles!==undefined&&(!Number.isSafeInteger(value.retryCycles)||(value.retryCycles as number)<0||(value.retryCycles as number)>3))||
        (value.uncertainRequests!==undefined&&(!Number.isSafeInteger(value.uncertainRequests)||(value.uncertainRequests as number)<0||(value.uncertainRequests as number)>1000))||
        (value.outputRepairs!==undefined&&(!Number.isSafeInteger(value.outputRepairs)||(value.outputRepairs as number)<0||(value.outputRepairs as number)>3))||
        !record(value.seen) || !Object.entries(value.seen).every(([key, n]) => /^[0-9a-f]{64}$/.test(key) && Number.isSafeInteger(n) && (n as number) > 0) || JSON.stringify(value).length > 1000000)
        throw new AppError('INVALID_INPUT', 'Provider continuation does not match this operation or is corrupt.');
    const calls = new Set<string>(), outputs = new Set<string>();
    for (const item of value.items as Record<string, unknown>[]) {
        if (item.type === 'function_call') {
            // Arguments are untrusted model output. Preserve malformed calls so
            // executeCall can return a schema error without touching the files.
            callEnvelope(item,provider==='deepseek-responses');
            if (calls.has(item.call_id as string))
                throw new AppError('INVALID_INPUT', 'Duplicate tool call identity.');
            calls.add(item.call_id as string);
        }
        else if (item.type === 'function_call_output') {
            if (typeof item.call_id !== 'string' || !calls.has(item.call_id) || outputs.has(item.call_id) || typeof item.output !== 'string')
                throw new AppError('INVALID_INPUT', 'Unmatched tool result.');
            outputs.add(item.call_id);
        }
        else if (item.type === 'message') {
            if (!['user', 'assistant'].includes(String(item.role)) || (!Array.isArray(item.content) && typeof item.content !== 'string'))
                throw new AppError('INVALID_INPUT', 'Invalid replay message.');
        }
        else if (item.type !== 'reasoning')
            throw new AppError('INVALID_INPUT', 'Unsupported replay item.');
    }
    return structuredClone(value) as unknown as ModelContinuation;
}
