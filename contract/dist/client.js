// A typed client for the API, for the web admin panel and for Node scripts
// and tests. No dependencies: it uses the platform's fetch (browsers, and
// Node 18 and later).
//
//   const api = createClient({ baseUrl, getAccessToken: () => token });
//   const machines = await api.call('GET /v1/machines', { query: { activeOnly: true } });
//   await api.call('DELETE /v1/machines/:id', { params: { id: 3 } });
import { ROUTES } from './generated/routes.js';
/** An error response, with the contract's code. */
export class ApiRequestError extends Error {
    status;
    code;
    details;
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
        this.name = 'ApiRequestError';
    }
}
const routeByKey = new Map(ROUTES.map((r) => [r.key, r]));
function buildUrl(base, path, params, query) {
    let p = path.replace(/:(\w+)/g, (_, name) => {
        const v = params?.[name];
        if (v === undefined || v === null)
            throw new TypeError(`missing path parameter ${name}`);
        return encodeURIComponent(String(v));
    });
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
        if (v === undefined || v === null)
            continue;
        qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    const s = qs.toString();
    if (s)
        p += `?${s}`;
    return base.replace(/\/+$/, '') + p;
}
export function createClient(options) {
    const doFetch = options.fetch ?? fetch;
    async function send(key, input, retried) {
        const route = routeByKey.get(key);
        if (!route)
            throw new TypeError(`unknown route ${key}`);
        const headers = { accept: 'application/json', ...input.headers };
        const token = route.auth === 'none' ? null : await options.getAccessToken?.();
        if (token)
            headers.authorization = `Bearer ${token}`;
        if (input.idempotencyKey)
            headers['idempotency-key'] = input.idempotencyKey;
        let body;
        if (input.body instanceof FormData)
            body = input.body;
        else if (input.body !== undefined) {
            body = JSON.stringify(input.body);
            headers['content-type'] = 'application/json';
        }
        let res;
        try {
            res = await doFetch(buildUrl(options.baseUrl, route.path, input.params, input.query), {
                method: route.method, headers, body, signal: input.signal,
            });
        }
        catch (e) {
            throw new ApiRequestError(0, 'network_error', e.message);
        }
        if (res.status === 204)
            return undefined;
        const text = await res.text();
        let json = undefined;
        if (text) {
            try {
                json = JSON.parse(text);
            }
            catch {
                throw new ApiRequestError(res.status, 'unexpected_response', text.slice(0, 200));
            }
        }
        if (res.ok)
            return json;
        const err = json?.error;
        if (err?.code === 'token_expired' && !retried && options.onTokenExpired && (await options.onTokenExpired())) {
            return send(key, input, true);
        }
        throw new ApiRequestError(res.status, err?.code ?? 'unexpected_response', err?.message ?? res.statusText, err?.details);
    }
    return {
        /** Calls a route by its key, typed end to end. */
        call(key, ...[input]) {
            return send(key, (input ?? {}), false);
        },
    };
}
//# sourceMappingURL=client.js.map