# @stitchflow/contract

The StitchFlow API contract as code, for the Node API and the web admin panel —
and any other TypeScript or JavaScript project that talks to StitchFlow.

| Export | Is |
| --- | --- |
| Types | Every shape the API sends or receives (`Machine`, `EntryDraft`, `PayrollRow`, `DeletedItem`, `Me` …) and every enum, as the Dart apps name them. |
| `ROUTES`, `ApiRoutes` | All 97 endpoints: method, path, the permission action each needs, whether it is destructive; and the request and response type of each. |
| `ACTIONS`, `MODULES`, `ROLE_DEFAULTS`, `ROLE_CAN_CREATE` | The permission catalog — **generated from the SQL**, so it is the database's own. |
| `can`, `refusal`, `canCreate`, `canGrant`, `memberLevel`, `memberModules` | The permission rule. Tested against the database's `fn_member_can` for every role, owner flag, status, grant and action. |
| `ERROR_STATUS`, `ERROR_MEANING` | Every error code and its HTTP status. |
| `toDateOnly`, `parseDateOnly`, `monthRange`, `todayIn`, `roundMoney` … | Dates without times and money, the way the contract means them. |
| `createClient` | A typed fetch client. No dependencies: browsers and Node 18+. |
| `openapi.json` | The same contract as OpenAPI 3.1, for codegen, Swagger UI, Postman, request validation. |
| `catalog.json` | The permission catalog as plain JSON, for anything not written in TypeScript. |

No runtime dependencies. ES modules.

## Install

From the bundle (`stitchflow-contract-1.1.0.tgz`):

```bash
npm install ./stitchflow-contract-1.1.0.tgz
```

Or, inside the stitchflow-platform repo, as a workspace package (`"@stitchflow/contract": "workspace:*"`).

## In the Node API

Register every route from the table, and refuse what the member may not do
before any handler runs:

```ts
import Fastify from 'fastify';
import { ROUTES, refusal, ERROR_STATUS, type RouteKey } from '@stitchflow/contract';
import { handlers } from './handlers/index.js'; // Record<RouteKey, handler>

const app = Fastify();

for (const route of ROUTES) {
  app.route({
    method: route.method,
    url: route.path,                       // ':id' style, as Fastify and Express expect
    preHandler: async (req, reply) => {
      if (route.auth !== 'member') return; // sign-in, session and console routes check differently
      const member = req.member;           // { role, isOwner, status, grants } from the token + database
      const code = refusal(member, route.action!);
      if (code) return reply.code(ERROR_STATUS[code]).send({ error: { code, message: route.summary } });
    },
    handler: handlers[route.key as RouteKey],
  });
}
```

`refusal` is the fast check in the middleware; the database's `fn_member_can`
is the authority, and row-level security the second lock — see the handover.

Validate bodies with the OpenAPI schemas:

```ts
import openapi from '@stitchflow/contract/openapi.json' with { type: 'json' };
const entryDraftSchema = openapi.components.schemas.EntryDraft;
```

Type a handler by its route:

```ts
import type { ApiRoutes } from '@stitchflow/contract';

type SaveSlip = ApiRoutes['PUT /v1/production/entry'];
async function saveSlip(body: SaveSlip['body']): Promise<SaveSlip['response']> { /* … */ }
```

Dates and money:

```ts
import { todayIn, monthRange, roundMoney } from '@stitchflow/contract';

const today = todayIn(property.timezone);        // "2026-09-28" — the property's date, not the server's
const { start, end } = monthRange('2026-09');     // "2026-09-01", "2026-10-01"
const base = roundMoney((17000 / 30) * 26);       // 14733.33
```

## In the web admin panel

```ts
import { createClient } from '@stitchflow/contract';

export const api = createClient({
  baseUrl: import.meta.env.VITE_API_URL,
  getAccessToken: () => session.accessToken,
  onTokenExpired: async () => session.refresh(),   // true after refreshing; the call is retried once
});

const properties = await api.call('GET /v1/platform/properties', { query: { query: 'janki' } });
await api.call('PATCH /v1/platform/properties/:id', { params: { id: 7 }, body: { machineLimit: 12 } });
await api.call('PATCH /v1/platform/properties/:id', { params: { id: 7 }, body: { status: 'suspended' } });
```

Errors come back as `ApiRequestError` with the contract's `code` and
`details` — word the code in the user's language; the message is for logs.

Hide what the person cannot do. `GET /v1/me` carries the member and the
module levels that apply; turn it into the rule's input once:

```tsx
import { can, type Me, type MemberContext } from '@stitchflow/contract';

const toContext = (me: Me): MemberContext => ({
  role: me.member.role,
  isOwner: me.member.isOwner,
  status: me.member.status,
  userStatus: me.user.status,
  propertyStatus: me.property.status,
  grants: Object.fromEntries(me.modules.map((m) => [m.module, m.level])),
});

{can(toContext(me), 'machines.delete') && <DeleteButton />}
```

Hiding a button is a courtesy; the API refuses regardless.

## The rule, in one place

```
member, login and property all active?     no  → refuse
owner-only action?                         → only the owner
destructive action?                        → only a super admin, whatever the module level
otherwise                                  → the member's module level ≥ the action's level
module level = own grant, else the role default — never above the role's ceiling
```

## Rebuild

The catalog, `openapi.json` and `src/generated/` are generated from
`spec/*.mjs` and `../db/migrations`. After changing either:

```bash
npm install
npm run build     # generate + compile
npm test          # 19 tests, including parity with the SQL rule
```

A change to a permission starts in the SQL (`db/migrations`), never here.
