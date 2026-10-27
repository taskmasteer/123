import { createHash } from 'node:crypto';
import { AppError } from '../../../contracts/src/model.js';
import type { FileTools, ModelContinuation } from '../../../contracts/src/model.js';
import { record } from '../../../contracts/src/inputs.js';
export const toolFields = { list: [], read: ['path'], write: ['path', 'text'], replace: ['path', 'oldText', 'newText'] } as const;
export const toolsSchema = Object.entries(toolFields).map(([name, fields]) => ({ type: 'function', name, strict: true,
    description: `${name} local static website files.`, parameters: { type: 'object', properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])), required: fields, additionalProperties: false } }));
export function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
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
    const { name, args, callId } = parseCall(item);
    const snapshot = [];
    for (const path of (await tools.list()).sort())
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
            result = await tools.read(args.path!);
            break;
        case 'write':
            await tools.write(args.path!, args.text!);
            result = { ok: true };
            break;
        case 'replace':
            await tools.replace(args.path!, args.oldText!, args.newText!);
            result = { ok: true };
            break;
    }
    return { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) };
}
export function validateContinuation(value: unknown, binding: string): ModelContinuation {
    if (!record(value) || value.provider !== 'openai-responses' || value.version !== 1 || value.binding !== binding ||
        !Array.isArray(value.items) || value.items.length > 500 || !value.items.every(item => record(item) && typeof item.type === 'string') ||
        !['turns', 'retries', 'retryAt', 'inputTokens', 'outputTokens'].every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0) ||
        (value.turns as number) > 48 || (value.retries as number) > 3 || typeof value.transportExhausted !== 'boolean' || typeof value.requestPending !== 'boolean' || typeof value.summary !== 'string' ||
        (value.responseId !== null && typeof value.responseId !== 'string') || ![null, 'final', 'refused', 'incomplete', 'failed', 'cancelled', 'stalled'].includes(value.terminal as null) ||
        (value.recoverable!==undefined&&(!['account','configuration'].includes(String(value.recoverable))||value.terminal!=='failed'))||
        (value.uncertainRequests!==undefined&&(!Number.isSafeInteger(value.uncertainRequests)||(value.uncertainRequests as number)<0||(value.uncertainRequests as number)>1000))||
        !record(value.seen) || !Object.entries(value.seen).every(([key, n]) => /^[0-9a-f]{64}$/.test(key) && Number.isSafeInteger(n) && (n as number) > 0) || JSON.stringify(value).length > 1000000)
        throw new AppError('INVALID_INPUT', 'Provider continuation does not match this operation or is corrupt.');
    const calls = new Set<string>(), outputs = new Set<string>();
    for (const item of value.items as Record<string, unknown>[]) {
        if (item.type === 'function_call') {
            parseCall(item);
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
