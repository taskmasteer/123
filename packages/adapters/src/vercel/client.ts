export class VercelError extends Error {
    constructor(readonly status: number, readonly retryAfter = 60000) { super('Vercel request was not confirmed.'); }
}
export class VercelClient {
    constructor(readonly options: {
        token: string;
        accountId: string;
        fetch?: typeof fetch;
    }) {
        if (!options.token || !/^team_[a-zA-Z0-9]+$/.test(options.accountId))
            throw new Error('Explicit Vercel team configuration required.');
    }
    async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<any> {
        if (!/^\/v\d+\//.test(path) || path.includes('://'))
            throw new Error('Invalid provider route.');
        const url = new URL(path, 'https://api.vercel.com');
        url.searchParams.set('teamId', this.options.accountId);
        const response = await (this.options.fetch ?? fetch)(url, { method, headers: { authorization: 'Bearer ' + this.options.token,
                'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json', ...headers },
            ...(body === undefined ? {} : { body: body instanceof Uint8Array ? Buffer.from(body) : JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!response.ok) {
            await response.body?.cancel();
            const seconds = Number(response.headers.get('retry-after'));
            throw new VercelError(response.status, Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 86400000) : 60000);
        }
        const reader = response.body?.getReader(), parts: Uint8Array[] = [];
        let length = 0;
        if (reader)
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done)
                        break;
                    length += chunk.value.length;
                    if (length > 2000000)
                        throw new Error('Provider response exceeds limit.');
                    parts.push(chunk.value);
                }
            }
            finally {
                await reader.cancel();
            }
        if (!length)
            return null;
        return JSON.parse(Buffer.concat(parts).toString('utf8'));
    }
}
