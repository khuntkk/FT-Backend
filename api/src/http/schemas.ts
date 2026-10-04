// Request validation from the contract's openapi.json, so a request the
// contract calls malformed never reaches a service.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RouteInfo } from '@stitchflow/contract';

type Json = any;

const openapi: Json = JSON.parse(
  readFileSync(fileURLToPath(import.meta.resolve('@stitchflow/contract/openapi.json')), 'utf8'),
);

/** Every component schema, as one schema Fastify's Ajv can reference: "sf#/$defs/Name". */
export const sharedSchema: Json = { $id: 'sf', $defs: rewriteRefs(openapi.components.schemas) };

function rewriteRefs(node: Json): Json {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = k === '$ref' && typeof v === 'string'
        ? v.replace('#/components/schemas/', 'sf#/$defs/')
        : rewriteRefs(v);
    }
    return out;
  }
  return node;
}

/** Query parameters sent comma-separated (style form, explode false), per route. */
export const arrayQueryParams = new Map<string, string[]>();

export function routeSchema(route: RouteInfo): Json {
  const op = openapi.paths[route.path.replace(/:(\w+)/g, '{$1}')]?.[route.method.toLowerCase()];
  if (!op) return {};
  const schema: Json = {};
  const params = (op.parameters ?? []) as Json[];
  const group = (where: string) => {
    const ps = params.filter((p) => p.in === where);
    if (!ps.length) return undefined;
    return rewriteRefs({
      type: 'object',
      properties: Object.fromEntries(ps.map((p) => [p.name, p.schema])),
      required: ps.filter((p) => p.required).map((p) => p.name),
    });
  };
  schema.params = group('path');
  schema.querystring = group('query');
  const arrays = params.filter((p) => p.in === 'query' && p.schema?.type === 'array').map((p) => p.name);
  if (arrays.length) arrayQueryParams.set(route.key, arrays);
  const body = op.requestBody?.content?.['application/json']?.schema;
  if (body) schema.body = rewriteRefs(body);
  for (const k of Object.keys(schema)) if (schema[k] === undefined) delete schema[k];
  return schema;
}

/** Ajv settings for these schemas. */
export const ajvOptions = {
  customOptions: {
    // The contract carries formats Ajv does not know (int64) and OpenAPI
    // keywords it does not either; neither should stop the server.
    strict: false,
    // Money is multipleOf 0.01; floating point needs the tolerance.
    multipleOfPrecision: 9,
    coerceTypes: 'array' as const,
    removeAdditional: false as const,
    allErrors: true,
  },
};
