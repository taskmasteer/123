import { createResponsesModel } from './openai/responses.js';
export const deepseekModel = 'deepseek-flash';
export function createDeepSeekModel(apiKey: string, transport: typeof fetch = fetch) {
  return createResponsesModel({ apiKey, model: deepseekModel, provider: 'deepseek' }, transport);
}
