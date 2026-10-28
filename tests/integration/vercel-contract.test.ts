import { expect, it } from 'vitest';
import { VercelClient } from '../../packages/adapters/src/vercel/client.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { digest, manifestHash, publisherConfiguration, publicationHeaders } from '../../packages/core/src/publication.js';
import { createDeployment, promoteDeployment } from '../../packages/adapters/src/vercel/publish.js';
import { uploadFile } from '../../packages/adapters/src/vercel/upload.js';
import { matchesDeployment } from '../../packages/adapters/src/vercel/reconcile.js';
import { verifyPublicHttps } from '../../packages/adapters/src/public-https.js';
import type { Manifest } from '../../packages/contracts/src/model.js';
import { domainSetup } from '../../packages/adapters/src/vercel/domains.js';
it('domain setup chooses preferred A records for an apex and CNAME for a subdomain without conflicting DNS instructions',()=>{
 const config={misconfigured:true,recommendedCNAME:[{rank:1,value:'preferred.vercel-dns.com'}],recommendedIPv4:[{rank:2,value:['192.0.2.2']},{rank:1,value:['192.0.2.1']}]};
 expect(domainSetup('example.com',{name:'example.com',apexName:'example.com',verified:false},config)).toEqual({verified:false,records:[{type:'A',name:'example.com',value:'192.0.2.1'}]});
 expect(domainSetup('example.co.uk',{name:'example.co.uk',apexName:'example.co.uk',verified:false},config)).toEqual({verified:false,records:[{type:'A',name:'example.co.uk',value:'192.0.2.1'}]});
 expect(domainSetup('www.example.com',{name:'www.example.com',apexName:'example.com',verified:true},config)).toEqual({verified:false,records:[{type:'CNAME',name:'www.example.com',value:'preferred.vercel-dns.com'}]});
});
it('publication transport accepts successful upload without JSON and binds server account', async () => {
    const requests: {
        url: string;
        init: RequestInit;
    }[] = [];
    const client = new VercelClient({ token: 'fixture-secret', accountId: 'team_fixture', fetch: async (input, init) => {
            requests.push({ url: String(input), init: init! });
            return new Response(null, { status: 200 });
        } });
    await expect(uploadFile(client,{path:'index.html',bytes:Buffer.from('hello'),mediaType:'text/html'},'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',5)).resolves.toBeUndefined();
    expect(requests[0]!.url).toBe('https://api.vercel.com/v2/files?teamId=team_fixture');
    expect(requests[0]!.init.redirect).toBe('error');
    expect(new Headers(requests[0]!.init.headers).get('content-length')).toBe('5');
});
it('publication transport classifies quota without exposing provider body or token', async () => {
    const client = new VercelClient({ token: 'fixture-secret', accountId: 'team_fixture', fetch: async () => new Response('private provider text', { status: 429, headers: { 'retry-after': '60' } }) });
    await expect(client.call('POST', '/v13/deployments', {})).rejects.toMatchObject({ status: 429, retryAfter: 60000 });
});
// This is deliberately separate from fixtures. Merely having provider credentials
// in the environment never enables network calls or production promotion.
it.skipIf(process.env.SITE_FACTORY_VERCEL_CONTRACT !== 'AUTHORIZE_DEDICATED_DEMO_PROMOTION')('live opt-in REST static envelope enforces headers and exact alias/content', async () => {
    const required = (name: string) => { const value = process.env[name]; if (!value)
        throw new Error('Explicit contract configuration missing: ' + name); return value; };
    const client = new VercelClient({ token: required('SITE_FACTORY_VERCEL_CONTRACT_TOKEN'), accountId: required('SITE_FACTORY_VERCEL_CONTRACT_TEAM') });
    const projectId = required('SITE_FACTORY_VERCEL_CONTRACT_PROJECT'), hostname = required('SITE_FACTORY_VERCEL_CONTRACT_DOMAIN');
    const project = await client.call('GET', '/v9/projects/' + encodeURIComponent(projectId));
    expect(project).toMatchObject({ id: projectId, accountId: client.options.accountId, framework: null, buildCommand: '', installCommand: '' });
    expect(project.name).toMatch(/^sf-contract-/);
    const id = randomUUID(), bytes = Buffer.from('<!doctype html><html lang="en"><title>Site Factory REST acceptance</title><h1>' + id + '</h1></html>');
    const files = [{ path: 'index.html', mediaType: 'text/html', bytes }, { path: 'proof.svg', mediaType: 'image/svg+xml', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>') }];
    const manifest: Manifest = { id, siteId: id, templateVersion: 'contract-v1', createdAt: Date.now(), files: files.map(f => ({ path: f.path, mediaType: f.mediaType, size: f.bytes.length, sha256: digest(f.bytes), sha1: digest(f.bytes, 'sha1'), objectKey: 'unused-contract/' + f.path })) };
    for (const file of [...files, publisherConfiguration])
        await uploadFile(client, file, digest(file.bytes, 'sha1'), file.bytes.length);
    const binding = { id, siteId: id, revisionId: id, manifestHash: manifestHash(manifest), projectId, projectName: project.name };
    // A lost create response fails this acceptance run; do not blindly retry it.
    let deployment = await createDeployment(client, binding, manifest);
    expect(matchesDeployment(deployment, binding)).toBe(true);
    const deploymentId = deployment.id ?? deployment.uid;
    for (let i = 0; i < 30 && deployment.readyState !== 'READY'; i++) {
        expect(['ERROR', 'CANCELED']).not.toContain(deployment.readyState);
        await delay(2000);
        deployment = await client.call('GET', '/v13/deployments/' + encodeURIComponent(deploymentId));
    }
    expect(deployment.readyState).toBe('READY');
    await promoteDeployment(client, projectId, deploymentId);
    let alias: any;
    for (let i = 0; i < 20; i++) {
        alias = await client.call('GET', '/v4/aliases/' + encodeURIComponent(hostname));
        if (alias.deploymentId === deploymentId)
            break;
        await delay(2000);
    }
    expect(alias).toMatchObject({ alias: hostname, projectId, deploymentId });
    for (const file of files)
        await verifyPublicHttps({ hostname, path: '/' + file.path, size: file.bytes.length, sha256: digest(file.bytes), mediaType: file.mediaType, headers: publicationHeaders });
}, 150000);
