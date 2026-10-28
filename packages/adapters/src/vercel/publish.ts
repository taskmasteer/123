import type { Manifest } from '../../../contracts/src/model.js';
import { deploymentFiles } from '../../../core/src/publication.js';
import type { VercelClient } from './client.js';
export interface ProviderBinding {
    id: string;
    siteId: string;
    revisionId: string;
    manifestHash: string;
    projectId: string;
    projectName: string;
}
export function deploymentMeta(b: ProviderBinding) { return { sfIntent: b.id, sfSite: b.siteId, sfRevision: b.revisionId, sfManifest: b.manifestHash }; }
export async function createDeployment(client: VercelClient, b: ProviderBinding, manifest: Manifest) {
    return client.call('POST', '/v13/deployments', { name: b.projectName, project: b.projectId, files: deploymentFiles(manifest), meta: deploymentMeta(b), projectSettings: { framework: null, buildCommand: '', installCommand: '', outputDirectory: null } });
}
export async function promoteDeployment(client: VercelClient, projectId: string, deploymentId: string) { await client.call('POST', `/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}`); }
