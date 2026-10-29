import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
export function launcherEnvironment(base = process.env) { const env = {...base}; if (env.NO_COLOR !== undefined) delete env.FORCE_COLOR; return env; }
export function runNode(script, args = [], options = {}) {
  const result = spawnSync(process.execPath, [resolve(script), ...args], { stdio: 'inherit', windowsHide: true, env: launcherEnvironment(), ...options });
  if (result.error) throw result.error; if (result.status !== 0) throw new Error(`${script} failed (${result.status ?? result.signal})`);
}
