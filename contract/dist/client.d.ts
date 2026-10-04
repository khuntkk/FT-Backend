import type { ApiRoutes, RouteKey } from './generated/routes.js';
import type { ErrorCode } from './generated/types.js';
type Input<K extends RouteKey> = (keyof ApiRoutes[K]['params'] extends never ? {
    params?: undefined;
} : {
    params: ApiRoutes[K]['params'];
}) & (keyof ApiRoutes[K]['query'] extends never ? {
    query?: undefined;
} : {
    query: ApiRoutes[K]['query'];
}) & (ApiRoutes[K]['body'] extends undefined ? {
    body?: undefined;
} : {
    body: ApiRoutes[K]['body'];
}) & {
    headers?: Record<string, string>;
    idempotencyKey?: string;
    signal?: AbortSignal;
};
/** An error response, with the contract's code. */
export declare class ApiRequestError extends Error {
    readonly status: number;
    readonly code: ErrorCode | 'network_error' | 'unexpected_response';
    readonly details?: Record<string, unknown> | undefined;
    constructor(status: number, code: ErrorCode | 'network_error' | 'unexpected_response', message: string, details?: Record<string, unknown> | undefined);
}
export interface ClientOptions {
    /** e.g. "https://api.example.com" — without /v1. */
    baseUrl: string;
    getAccessToken?: () => string | null | undefined | Promise<string | null | undefined>;
    /** Called once on token_expired; return true after refreshing to retry. */
    onTokenExpired?: () => Promise<boolean>;
    fetch?: typeof fetch;
}
export declare function createClient(options: ClientOptions): {
    /** Calls a route by its key, typed end to end. */
    call<K extends RouteKey>(key: K, ...[input]: keyof Input<K> extends never ? [] : [Input<K>] | []): Promise<ApiRoutes[K]["response"]>;
};
export type ApiClient = ReturnType<typeof createClient>;
export {};
//# sourceMappingURL=client.d.ts.map