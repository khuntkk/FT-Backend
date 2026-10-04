// A typed client for the API, for the web admin panel and for Node scripts
// and tests. No dependencies: it uses the platform's fetch (browsers, and
// Node 18 and later).
//
//   const api = createClient({ baseUrl, getAccessToken: () => token });
//   const machines = await api.call('GET /v1/machines', { query: { activeOnly: true } });
//   await api.call('DELETE /v1/machines/:id', { params: { id: 3 } });

import { ROUTES } from './generated/routes.js';
import type { ApiRoutes, RouteKey } from './generated/routes.js';
import type { ApiErrorBody, ErrorCode } from './generated/types.js';

type Input<K extends RouteKey> =
  & (keyof ApiRoutes[K]['params'] extends never ? { params?: undefined } : { params: ApiRoutes[K]['params'] })
  & (keyof ApiRoutes[K]['query'] extends never ? { query?: undefined } : { query: ApiRoutes[K]['query'] })
  & (ApiRoutes[K]['body'] extends undefined ? { body?: undefined } : { body: ApiRoutes[K]['body'] })
  & { headers?: Record<string, string>; idempotencyKey?: string; signal?: AbortSignal };

/** An error response, with the contract's code. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'network_error' | 'unexpected_response',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export interface ClientOptions {
  /** e.g. "https://api.example.com" — without /v1. */
  baseUrl: string;
  getAccessToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /** Called once on token_expired; return true after refreshing to retry. */
  onTokenExpired?: () => Promise<boolean>;
  fetch?: typeof fetch;
}

const routeByKey = new Map(ROUTES.map((r) => [r.key, r]));

function buildUrl(base: string, path: string, params?: object, query?: object): string {
  let p = path.replace(/:(\w+)/g, (_, name: string) => {
    const v = (params as Record<string, unknown> | undefined)?.[name];
    if (v === undefined || v === null) throw new TypeError(`missing path parameter ${name}`);
    return encodeURIComponent(String(v));
  });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = qs.toString();
  if (s) p += `?${s}`;
  return base.replace(/\/+$/, '') + p;
}

export function createClient(options: ClientOptions) {
  const doFetch = options.fetch ?? fetch;

  async function send<K extends RouteKey>(key: K, input: Input<K>, retried: boolean): Promise<ApiRoutes[K]['response']> {
    const route = routeByKey.get(key);
    if (!route) throw new TypeError(`unknown route ${key}`);

    const headers: Record<string, string> = { accept: 'application/json', ...input.headers };
    const token = route.auth === 'none' ? null : await options.getAccessToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    if (input.idempotencyKey) headers['idempotency-key'] = input.idempotencyKey;

    let body: BodyInit | undefined;
    if (input.body instanceof FormData) body = input.body;
    else if (input.body !== undefined) {
      body = JSON.stringify(input.body);
      headers['content-type'] = 'application/json';
    }

    let res: Response;
    try {
      res = await doFetch(buildUrl(options.baseUrl, route.path, input.params, input.query), {
        method: route.method, headers, body, signal: input.signal,
      });
    } catch (e) {
      throw new ApiRequestError(0, 'network_error', (e as Error).message);
    }

    if (res.status === 204) return undefined as ApiRoutes[K]['response'];
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiRequestError(res.status, 'unexpected_response', text.slice(0, 200));
      }
    }
    if (res.ok) return json as ApiRoutes[K]['response'];

    const err = (json as { error?: ApiErrorBody } | undefined)?.error;
    if (err?.code === 'token_expired' && !retried && options.onTokenExpired && (await options.onTokenExpired())) {
      return send(key, input, true);
    }
    throw new ApiRequestError(
      res.status,
      err?.code ?? 'unexpected_response',
      err?.message ?? res.statusText,
      err?.details as Record<string, unknown> | undefined,
    );
  }

  return {
    /** Calls a route by its key, typed end to end. */
    call<K extends RouteKey>(key: K, ...[input]: keyof Input<K> extends never ? [] : [Input<K>] | []): Promise<ApiRoutes[K]['response']> {
      return send(key, (input ?? {}) as Input<K>, false);
    },
  };
}

export type ApiClient = ReturnType<typeof createClient>;
