import { randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../../../packages/contracts/src/model.js';
import { object, string, uuid } from '../../../packages/contracts/src/http.js';
import type { WorkerDeps } from './pipeline.js';
import { controlOrigin, createRemoteWorker } from './remote-worker.js';
import { runWorker } from './runner.js';
/** Private fixed-sidecar entry point; never exposed through desktop dispatch. */
export function createManagedRuntime(deps: () => WorkerDeps, ready: () => boolean, transport: typeof fetch = fetch) {
    let running: Promise<void> | null = null, abort: AbortController | null = null, lastError: string | null = null;
    async function stop() {
        abort?.abort();
        await running;
        running = null;
        abort = null;
    }
    async function admin(origin: string, path: string, accessToken: string, body: unknown) {
        let response: Response;
        try {
            response = await transport(controlOrigin(origin) + path, { method: 'POST', headers: { authorization: 'Bearer ' + accessToken, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) });
        }
        catch {
            throw new AppError('UNAVAILABLE', 'Нет связи с сервером регистрации. Повторите ту же регистрацию.');
        }
        if (!response.ok)
            throw new AppError(response.status === 409 ? 'CONFLICT' : response.status === 401 ? 'UNAUTHENTICATED' : response.status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE', 'Регистрация или отзыв не подтверждены сервером.');
        return response.json() as Promise<unknown>;
    }
    return { stop, async request(method: string, params: unknown): Promise<unknown> {
            if (method === 'managed.prepare') {
                object(params, []);
                return { workerId: randomUUID(), token: randomBytes(32).toString('base64url') };
            }
            if (method === 'managed.status') {
                object(params, []);
                return { running: running !== null, error: lastError };
            }
            if (method === 'managed.stop') {
                object(params, []);
                await stop();
                return { running: false, error: lastError };
            }
            const p = object(params, ['workerId', 'token', 'name', 'controlOrigin', 'accessToken']), workerId = uuid(p.workerId), origin = controlOrigin(string(p.controlOrigin, 1000));
            if (method === 'managed.revoke') {
                await stop();
                await admin(origin, `/workers/${workerId}/revoke`, string(p.accessToken, 16000), {});
                return { ok: true };
            }
            const token = string(p.token, 43);
            if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token)
                throw new AppError('INVALID_INPUT', 'Некорректный ключ устройства.');
            if (method === 'managed.enroll') {
                const name = string(p.name, 100), result = object(await admin(origin, '/workers/enroll', string(p.accessToken, 16000), { workerId, name, token, controlOrigin: origin }), ['workerId', 'name']);
                if (result.workerId !== workerId || result.name !== name)
                    throw new AppError('INVALID_INPUT', 'Сервер вернул другую регистрацию.');
                return { workerId, name };
            }
            if (method === 'managed.start') {
                if (!ready())
                    throw new AppError('UNAVAILABLE', 'Сначала настройте реальную модель на устройстве.');
                if (running)
                    return { running: true, error: lastError };
                abort = new AbortController();
                lastError = null;
                running = runWorker(createRemoteWorker({ controlOrigin: origin, workerId, workerToken: token, fetch: transport }, deps()), workerId, abort.signal)
                    .catch(() => {
                    lastError = 'Исполнитель остановлен: проверьте доступ устройства и подключение.';
                    abort?.abort();
                })
                    .finally(() => {
                    running = null;
                });
                return { running: true, error: null };
            }
            throw new AppError('INVALID_INPUT', 'Неизвестная приватная команда.');
        } };
}
