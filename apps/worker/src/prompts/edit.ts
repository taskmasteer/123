import type { ModelRequest } from '../../../../packages/contracts/src/model.js';
import { generatePrompt } from './generate.js';
export function editPrompt(request: ModelRequest, legacy = false): string {
    return `${generatePrompt(request, legacy)}
This is an edit of immutable base ${request.baseManifestId}. The current files are authoritative, including all manual edits. Never replace the site with a fresh template.
Read affected files first. Change only what the instruction requests. Preserve unrelated wording, HTML, CSS, scripts and assets exactly; a color-only request must preserve all existing text. New visible content must remain in English.`;
}
