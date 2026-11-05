import test from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { connectHost, execute, fingerprint } from '../lib/linux-ssh.mjs';

test('SSH requires the pinned host key, authenticates a key and preserves stdin', async () => {
  const serverKeys = ssh2.utils.generateKeyPairSync('ed25519');
  const clientKeys = ssh2.utils.generateKeyPairSync('ed25519');
  const publicKey = ssh2.utils.parseKey(clientKeys.private);
  const server = new ssh2.Server({ hostKeys: [serverKeys.private] }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => {
      if (ctx.method !== 'publickey' || !ctx.key.data.equals(publicKey.getPublicSSH())) return ctx.reject();
      if (ctx.signature && !publicKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject();
      ctx.accept();
    });
    client.on('ready', () => client.on('session', accept => {
      accept().on('exec', (accept, reject, info) => {
        const stream = accept();
        if (info.command === 'hang') return;
        let text = '';
        stream.on('data', chunk => text += chunk);
        stream.on('end', () => { stream.write(text); stream.exit(0); stream.end(); });
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { host: '127.0.0.1', port: server.address().port, username: 'fixture', hostFingerprint: fingerprint(ssh2.utils.parseKey(serverKeys.private).getPublicSSH()) };
  try {
    await assert.rejects(connectHost({ ...config, hostFingerprint: '' }, { privateKey: clientKeys.private }), /fingerprint/);
    await assert.rejects(connectHost({ ...config, hostFingerprint: fingerprint(Buffer.from('wrong')) }, { privateKey: clientKeys.private }), /verification failed/);
    const client = await connectHost(config, { privateKey: clientKeys.private });
    try {
      assert.deepEqual(await execute(client, 'echo-input', 'fixture payload\n'), { code: 0, output: 'fixture payload\n', error: '' });
      await assert.rejects(execute(client, 'hang', '', 50), /timed out/);
    } finally { client.end(); }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
