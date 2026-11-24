import { createResponsesModel, type ResponsesConfig } from './openai/responses.js';
export const deepseekModel = 'deepseek-flash';
export function createDeepSeekModel(apiKey: string, transport: typeof fetch = fetch, onUsage?: ResponsesConfig['onUsage']) {
  return createResponsesModel({ apiKey, model: deepseekModel, provider: 'deepseek', ...(onUsage ? {onUsage} : {}) }, transport);
}
