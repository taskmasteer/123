import { AppError } from '../../contracts/src/model.js';
import type { FileTools, ModelPort, ModelRequest, ModelResult } from '../../contracts/src/model.js';
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
/** Explicit local demonstration adapter. Does not make a network request or claim model usage. */
export class FakeModel implements ModelPort {
  readonly runtimeStatus = { mode: 'demo', realModel: false } as const;
  async run(request: ModelRequest, tools: FileTools, signal: AbortSignal): Promise<ModelResult> {
    signal.throwIfAborted();
    if (request.mode === 'plan') return {summary:JSON.stringify({topic:'A demonstration concept for verifiable event tracing at '+request.site.domain}),inputTokens:0,outputTokens:0};
    const html = await tools.read('index.html');
    if (request.mode === 'edit') {
      // A deliberately narrow demonstration: replace only the existing main heading.
      // Instructions are literal English heading text; this is not natural-language model execution.
      const heading = /(<h1\b[^>]*>)[\s\S]*?(<\/h1>)/i;
      if (!heading.test(html)) throw new AppError('NEEDS_ATTENTION', 'Demo edit needs an existing main heading.');
      const next = html.replace(heading, (_match, open: string, close: string) => open + escape(request.instruction) + close);
      signal.throwIfAborted(); await tools.write('index.html', next);
      return { summary: 'Демо: заменён только главный заголовок на введённый текст. Остальные файлы сохранены.', inputTokens: 0, outputTokens: 0 };
    }
    const brief = request.site.input.about?.trim() || request.instruction;
    const next = html.replace(/(<h1\b[^>]*data-topic[^>]*>)[\s\S]*?(<\/h1>)/i, (_match, open: string, close: string) => open + escape(brief) + close)
      .replace(/(<title>)[\s\S]*?(<\/title>)/i, (_match, open: string, close: string) => open + escape(request.site.domain) + close);
    signal.throwIfAborted(); await tools.write('index.html', next);
    return { summary: 'Local demonstration generated from the selected original template.', inputTokens: 0, outputTokens: 0 };
  }
}
