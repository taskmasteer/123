import { deploymentMeta, type ProviderBinding } from './publish.js';
import type { VercelClient } from './client.js';
export function matchesDeployment(value: any, binding: ProviderBinding) {
    return !!value && typeof (value.id ?? value.uid) === 'string' && value.projectId === binding.projectId && Object.entries(deploymentMeta(binding)).every(([key, v]) => value.meta?.[key] === v);
}
/** One bounded page; the caller persists cursor/matches. Empty page is never absence proof. */
export async function findDeploymentPage(client: VercelClient, binding: ProviderBinding, until: number | null) {
    const result = await client.call('GET', `/v7/deployments?projectId=${encodeURIComponent(binding.projectId)}&limit=100${until === null ? '' : '&until=' + until}`);
    if (!Array.isArray(result?.deployments) || !result.pagination || !('next' in result.pagination))
        throw new Error('Incomplete deployment page.');
    const next = result.pagination.next;
    if (next !== null && (!Number.isSafeInteger(next) || next < 0 || (until !== null && next >= until)))
        throw new Error('Invalid deployment cursor.');
    return { matches: result.deployments.filter((d: any) => matchesDeployment(d, binding)).map((d: any) => String(d.uid ?? d.id)), next: next as number | null };
}
