import type { FileTools, ModelPort, ModelRequest, ModelResult } from '../../contracts/src/model.js';
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
/** Explicit local demonstration adapter. Does not make a network request or claim model usage. */
export class FakeModel implements ModelPort {
  readonly runtimeStatus = { mode: 'demo', realModel: false } as const;
  async run(request: ModelRequest, tools: FileTools, signal: AbortSignal): Promise<ModelResult> {
    signal.throwIfAborted();
    const html = await tools.read('index.html');
    const brief = request.site.input.about?.trim() || request.instruction;
    const next = html.replace(/(<h1\b[^>]*data-topic[^>]*>)[\s\S]*?(<\/h1>)/i, (_match, open: string, close: string) => open + escape(brief) + close)
      .replace(/(<title>)[\s\S]*?(<\/title>)/i, (_match, open: string, close: string) => open + escape(request.site.domain) + close);
    signal.throwIfAborted(); await tools.write('index.html', next);
    return { summary: 'Local demonstration generated from the selected original template.', inputTokens: 0, outputTokens: 0 };
  }
}
