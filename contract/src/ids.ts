// Ids are lower-case, time-ordered UUIDs (version 7) since contract 2.0.0.
// The same rule as the `id` schema in openapi.json, for code that receives an
// id from somewhere other than a validated request: a token, a cursor, an
// address bar.

import type { Id } from './generated/types.js';

export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True for a well-formed id: lower case, nothing around it. */
export const isId = (v: unknown): v is Id => typeof v === 'string' && ID_PATTERN.test(v);
