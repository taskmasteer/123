// Vercel Web Request handler. Credentials and SQL remain server-only.
import { Pool } from 'pg';
import { S3Client } from '@aws-sdk/client-s3';
import { createApp } from '../src/app.js';
import { configuredInvitations } from '../src/invitations.js';
import { createAuth } from '../src/auth.js';
import { SupabaseRepository, configureSnapshotConnection } from '../../../packages/adapters/src/supabase-repository.js';
import { PostgresQueue } from '../../../packages/adapters/src/postgres-queue.js';
import { R2Store, R2Transport } from '../../../packages/adapters/src/r2-store.js';
import { errorResponse, unavailable } from '../src/errors.js';
import { PostgresPublication } from '../../../packages/adapters/src/postgres-publication.js';
import { VercelClient } from '../../../packages/adapters/src/vercel/client.js';
import { verifyPublicHttps } from '../../../packages/adapters/src/public-https.js';
import { PostgresBackup } from '../../../packages/adapters/src/postgres-backup.js';
let app: ReturnType<typeof createApp> | undefined;
export async function handler(request: Request) {
    try {
        if (!app) {
            const env = process.env;
            if (!env.DATABASE_URL || !env.SUPABASE_URL)
                return unavailable();
            const repository = new SupabaseRepository(configureSnapshotConnection(new Pool({ connectionString: env.DATABASE_URL, max: 4 }), env.DATABASE_CONNECTION_MODE));
            const queue = new PostgresQueue(repository), issuer = new URL('/auth/v1', env.SUPABASE_URL).href;
            const auth = createAuth({ issuer, audience: 'authenticated', membership: id => repository.membership(id), worker: hash => repository.worker(hash) });
            const store = env.R2_ENDPOINT && env.R2_BUCKET && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
                ? new R2Store(repository, new R2Transport(new S3Client({ region: 'auto', endpoint: env.R2_ENDPOINT, credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } }), env.R2_BUCKET), queue)
                : undefined;
            const previewKey = env.PREVIEW_SIGNING_KEY ? Buffer.from(env.PREVIEW_SIGNING_KEY, 'base64') : undefined;
            if (previewKey && previewKey.length < 32)
                return unavailable();
            const invitations = configuredInvitations(repository, env);
            const publication = store && env.VERCEL_PUBLICATION_TOKEN && env.VERCEL_PUBLICATION_TEAM_ID ? new PostgresPublication(queue, store, new VercelClient({ token: env.VERCEL_PUBLICATION_TOKEN, accountId: env.VERCEL_PUBLICATION_TEAM_ID }), verifyPublicHttps) : undefined;
            app = createApp({ repository, auth, queue, ...(store ? { backup: new PostgresBackup(repository, store, invitations ? id => invitations.verifiedIdentity(id) : undefined) } : {}), ...(publication ? { publication } : {}), ...(invitations ? { invitations } : {}), ...(store ? { store } : {}), ...(previewKey ? { previewKey } : {}), ...(env.CONTROL_PUBLIC_ORIGIN ? { publicOrigin: env.CONTROL_PUBLIC_ORIGIN } : {}), allowedOrigins: (env.CONTROL_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean) });
        }
        return app(request);
    }
    catch (error) {
        return errorResponse(error);
    }
}
export default { fetch: handler };
