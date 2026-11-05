// Local administrator operation. No credentials on argv; no remote API exposure.
import { readFile } from 'node:fs/promises';
import { connectHost, execute, loadHost } from './lib/linux-ssh.mjs';

const [configFile, scriptFile] = process.argv.slice(2);
if (!configFile || !scriptFile) throw new Error('Usage: node scripts/linux-host.mjs <encrypted-host.json> <shell-script>');
const client = await connectHost(await loadHost(configFile));
try {
  const result = await execute(client, 'sudo -n bash -se', await readFile(scriptFile, 'utf8'), 600000);
  process.stdout.write(result.output);
  process.stderr.write(result.error);
  process.exitCode = result.code ?? 1;
} finally { client.end(); }
