import type { Manifest } from '../../contracts/src/model.js';
import { publisherPolicyVersion, publisherConfiguration, digest, publicationHeaders, manifestHash } from '../../core/src/publication.js';
import { matchesDeployment, findDeploymentPage } from './vercel/reconcile.js';
import { VercelClient, VercelError } from './vercel/client.js';
import type { verifyPublicHttps } from './public-https.js';
export type RecoveryObservation = {
    status: 'manual-required';
    reason: string;
} | {
    status: 'settled' | 'cancelled';
    deploymentId: string;
    verifiedAt: number;
    evidence: Record<string, unknown>;
};
export interface FrozenPublication {
    id: string;
    site_id: string;
    revision_id: string;
    manifest_id: string;
    manifest_hash: string;
    account_id: string;
    deployment_id: string | null;
    data: {
        projectId: string | null;
        projectName: string;
        domain: string;
        policyVersion: string;
        policyHash: string;
        [key: string]: unknown;
    };
}
/** Observation only. This function cannot upload, create, promote, attach or mutate a provider. */
export async function observeRecoveryPublication(client: VercelClient, verify: typeof verifyPublicHttps, row: FrozenPublication, manifest: Manifest): Promise<RecoveryObservation> {
    const manual = (reason: string): RecoveryObservation => ({ status: 'manual-required', reason }), p = row.data, account = client.options.accountId;
    if (row.account_id !== account)
        return manual('configured-account-mismatch');
    if (!p || typeof p.projectId !== 'string' || !/^prj_[A-Za-z0-9]+$/.test(p.projectId) || p.projectName !== 'sf-' + row.site_id)
        return manual('missing-frozen-project');
    if (p.policyVersion !== publisherPolicyVersion || p.policyHash !== digest(publisherConfiguration.bytes) || manifest.id !== row.manifest_id || manifest.siteId !== row.site_id || manifestHash(manifest) !== row.manifest_hash)
        return manual('frozen-policy-or-manifest-mismatch');
    try {
        const team = await client.call('GET', '/v2/teams/' + encodeURIComponent(account));
        if (team?.id !== account)
            return manual('unverified-configured-account');
        const project = await client.call('GET', '/v9/projects/' + encodeURIComponent(p.projectId));
        if (project?.id !== p.projectId || project.name !== p.projectName || project.accountId !== account || project.framework !== null || project.buildCommand !== '' || project.installCommand !== '')
            return manual('project-binding-or-configuration-mismatch');
        const binding = { id: row.id, siteId: row.site_id, revisionId: row.revision_id, manifestHash: row.manifest_hash, projectId: p.projectId, projectName: p.projectName };
        let deploymentId = row.deployment_id;
        if (!deploymentId) {
            let cursor: number | null = null, finished = false;
            const found = new Set<string>();
            for (let page = 0; page < 3; page++) {
                const result = await findDeploymentPage(client, binding, cursor);
                for (const id of result.matches)
                    found.add(id);
                if (found.size > 1)
                    return manual('ambiguous-deployments');
                cursor = result.next;
                if (cursor === null) {
                    finished = true;
                    break;
                }
            }
            if (!finished)
                return manual('deployment-list-incomplete');
            if (found.size !== 1)
                return manual('no-positive-deployment-proof');
            deploymentId = [...found][0]!;
        }
        if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId))
            return manual('invalid-deployment-identity');
        const deployment = await client.call('GET', '/v13/deployments/' + encodeURIComponent(deploymentId));
        if (!matchesDeployment(deployment, binding) || (deployment.id ?? deployment.uid) !== deploymentId)
            return manual('deployment-binding-mismatch');
        let alias: any = null;
        try {
            alias = await client.call('GET', '/v4/aliases/' + encodeURIComponent(p.domain));
        }
        catch (error) {
            if (!(error instanceof VercelError && error.status === 404))
                throw error;
        }
        if (['ERROR', 'CANCELED'].includes(deployment.readyState)) {
            if (alias && (alias.alias !== p.domain || alias.projectId !== p.projectId || typeof alias.deploymentId !== 'string' || alias.deploymentId === deploymentId))
                return manual('failed-deployment-alias-ambiguous');
            return { status: 'cancelled', deploymentId, verifiedAt: Date.now(), evidence: { accountId: account, projectId: p.projectId, deploymentId, readyState: deployment.readyState, aliasDeploymentId: alias?.deploymentId ?? null } };
        }
        if (deployment.readyState !== 'READY')
            return manual('deployment-not-terminal');
        if (alias?.alias !== p.domain || alias.projectId !== p.projectId || alias.deploymentId !== deploymentId)
            return manual('public-alias-not-confirmed');
        const index = manifest.files.find(f => f.path === 'index.html');
        if (!index)
            return manual('missing-index');
        const observed = await verify({ hostname: p.domain, path: '/index.html', sha256: index.sha256, size: index.size, mediaType: index.mediaType, headers: publicationHeaders });
        if (!Number.isSafeInteger(observed.verifiedAt) || observed.verifiedAt <= 0)
            return manual('invalid-public-proof');
        if (client.options.accountId !== account)
            return manual('configured-account-changed');
        return { status: 'settled', deploymentId, verifiedAt: observed.verifiedAt, evidence: { ...observed, accountId: account, hostname: p.domain, projectId: p.projectId, deploymentId, manifestHash: row.manifest_hash, indexSha256: index.sha256, policyHash: p.policyHash } };
    }
    catch {
        return manual('provider-or-public-proof-unavailable');
    }
}
