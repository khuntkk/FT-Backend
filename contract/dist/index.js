// @stitchflow/contract — the StitchFlow API contract for TypeScript.
//
//   types      every shape the API sends or receives, and its enums
//   routes     the route table (ROUTES) and typed requests/responses (ApiRoutes)
//   catalog    modules, actions, role defaults — generated from the SQL
//   errors     error codes and their HTTP status
//   permissions can(), canCreate(), canGrant(), memberLevel() — the SQL rule, in code
//   dates      "YYYY-MM-DD" and money helpers
//   client     a typed fetch client
//
// The same contract as openapi.json (in this package) and docs/API.md.
export * from './generated/types.js';
export * from './generated/routes.js';
export * from './generated/catalog.js';
export * from './generated/errors.js';
export * from './permissions.js';
export * from './dates.js';
export * from './client.js';
//# sourceMappingURL=index.js.map