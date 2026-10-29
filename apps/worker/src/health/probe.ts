import { verifyPublicHttps, publicHttpsFailure, type HttpsDependencies } from '../../../../packages/adapters/src/public-https.js';
import { publicationPolicy } from '../../../../packages/core/src/publication.js';
import { codeStatus, healthCaption, type HealthClaim, type HealthCode } from '../../../../packages/contracts/src/monitoring.js';
/** Claim is server-selected, never a renderer URL. */
export function createHealthProbe(dependencies: HttpsDependencies = {}) {
    return async function probeSite(claim: HealthClaim, signal: AbortSignal) {
        signal.throwIfAborted();
        const headers = publicationPolicy(claim.policyVersion, claim.policyHash);
        let code: HealthCode = 'policy_unavailable';
        if (headers)
            try {
                await verifyPublicHttps({ hostname: claim.hostname, path: '/index.html', ...claim.file, headers }, { ...dependencies, signal });
                code = 'ok';
            }
            catch (error) {
                signal.throwIfAborted();
                code = publicHttpsFailure(error).code;
            }
        return { checkedAt: Date.now(), status: codeStatus(code), detail: healthCaption(code), code };
    };
}
