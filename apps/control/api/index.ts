// Vercel Web Request handler. Secrets stay exclusively in this server entry point.
import {Pool} from 'pg';
import {S3Client} from '@aws-sdk/client-s3';
import {createApp} from '../src/app.js';
import {createAuth} from '../src/auth.js';
import {SupabaseRepository} from '../../../packages/adapters/src/supabase-repository.js';
import {R2Store,R2Transport} from '../../../packages/adapters/src/r2-store.js';
import {errorResponse,unavailable} from '../src/errors.js';
let app:ReturnType<typeof createApp>|undefined;
export default async function handler(request:Request){try{if(!app){const env=process.env;if(!env.DATABASE_URL||!env.SUPABASE_URL)return unavailable();const repository=new SupabaseRepository(new Pool({connectionString:env.DATABASE_URL,max:4}));const issuer=new URL('/auth/v1',env.SUPABASE_URL).href;const auth=createAuth({issuer,audience:'authenticated',membership:id=>repository.membership(id),worker:hash=>repository.worker(hash)});const store=env.R2_ENDPOINT&&env.R2_BUCKET&&env.R2_ACCESS_KEY_ID&&env.R2_SECRET_ACCESS_KEY?new R2Store(repository,new R2Transport(new S3Client({region:'auto',endpoint:env.R2_ENDPOINT,credentials:{accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY}}),env.R2_BUCKET)):undefined;const previewKey=env.PREVIEW_SIGNING_KEY?Buffer.from(env.PREVIEW_SIGNING_KEY,'base64'):undefined;if(previewKey&&previewKey.length<32)return unavailable();app=createApp({repository,auth,...(store?{store}:{}),...(previewKey?{previewKey}:{}),...(env.CONTROL_PUBLIC_ORIGIN?{publicOrigin:env.CONTROL_PUBLIC_ORIGIN}:{}),allowedOrigins:(env.CONTROL_ALLOWED_ORIGINS??'').split(',').filter(Boolean)});}return app(request);}catch(error){return errorResponse(error);}}
