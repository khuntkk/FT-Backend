// Registers every route in the contract's table and wraps each in the same
// steps, so no handler can forget one:
//
//   token → one transaction (role + app.property_id) → member, statuses,
//   password gate → fn_member_can(route action) → idempotency → handler →
//   audit row for destructive and console actions → commit → change notices
//
// fn_member_can is the authority on what a member may do; the contract's
// refusal() only picks which 403 code explains a "no".

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ROUTES, refusal, type ActionKey, type RouteInfo } from '@stitchflow/contract';
import { verifyAccessToken, type AccessClaims } from '../auth/tokens.ts';
import type { Db, Tx } from '../db/db.ts';
import { signInPreflight, identifierColumn } from '../services/rateLimit.ts';
import { ApiError } from './errors.ts';
import { arrayQueryParams, routeSchema } from './schemas.ts';
import type { AnyHandler, AuditNote, Member, PlatformStaff, Services } from './types.ts';

/** Per-IP requests a minute on the unauthenticated POST routes. */
const UNAUTH_MAX_PER_MINUTE = 120;

export function registerRoutes(
  app: FastifyInstance,
  db: Db,
  services: Services,
  handlers: Record<string, AnyHandler>,
  unauthLimit = UNAUTH_MAX_PER_MINUTE,
): void {
  for (const route of ROUTES) {
    const handler = handlers[route.key];
    app.route({
      method: route.method,
      url: route.path,
      schema: routeSchema(route),
      preValidation: splitArrayQuery(route),
      // The unauthenticated POSTs (sign-in, refresh) get a per-IP limit; the
      // plugin is registered with global: false (app.ts).
      ...(route.auth === 'none' && route.method === 'POST' && {
        config: { rateLimit: { max: unauthLimit, timeWindow: '1 minute' } },
      }),
      handler: async (req, reply) => {
        if (!handler) {
          return reply.code(501).send({ error: { code: 'not_implemented', message: `${route.key} is not built yet.` } });
        }
        const result = await dispatch(route, handler, db, services, req, reply);
        if (reply.sent) return reply;
        if (result instanceof Replay) {
          reply.header('Idempotent-Replayed', 'true');
          return result.status === 204 ? reply.code(204).send() : reply.code(result.status).send(result.body);
        }
        if (result === undefined || result === null) return reply.code(204).send();
        return reply.code(200).send(result);
      },
    });
  }
}

/** The stored first response to a repeated Idempotency-Key. */
class Replay {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    this.status = status;
    this.body = body;
  }
}

// "1,2,3" → ["1","2","3"] before validation, for the contract's array queries.
function splitArrayQuery(route: RouteInfo) {
  const names = arrayQueryParams.get(route.key);
  if (!names) return undefined;
  return async (req: FastifyRequest) => {
    const q = req.query as Record<string, unknown>;
    for (const n of names) {
      if (typeof q[n] === 'string') q[n] = (q[n] as string).split(',').filter(Boolean);
    }
  };
}

function bearer(req: FastifyRequest, secret: string): AccessClaims {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw new ApiError('unauthenticated', 'No token.');
  return verifyAccessToken(h.slice(7), secret);
}

/** What a console session without two-factor may still call, when it is required (/v1/auth/* is not a platform route). */
const TOTP_SETUP_ROUTES = new Set([
  'GET /v1/platform/me', 'POST /v1/platform/auth/totp/setup', 'POST /v1/platform/auth/totp/enable',
]);

/** The identifier and password a sign-in body carries, or null (refresh). */
function signInIdentifier(route: RouteInfo, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const password = typeof b.password === 'string' ? b.password : '';
  if (route.key === 'POST /v1/platform/auth/login' && typeof b.email === 'string') {
    return { column: 'email', value: b.email.trim(), password };
  }
  if (route.key === 'POST /v1/auth/login' && typeof b.identifier === 'string') {
    const value = b.identifier.trim();
    return { column: identifierColumn(value), value, password };
  }
  return null;
}

async function dispatch(
  route: RouteInfo,
  handler: AnyHandler,
  db: Db,
  services: Services,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  let note: AuditNote | null = null;
  const base = {
    params: req.params,
    query: req.query,
    body: req.body,
    req,
    reply,
    services,
    audit: (n: AuditNote) => void (note = { ...note, ...n }),
  };
  const isPlatformPath = route.path.startsWith('/v1/platform/');

  if (route.auth === 'none') {
    if (route.method === 'POST') {
      // Limits first, before a connection is taken: a refused request costs no round trip.
      const wait = signInPreflight(signInIdentifier(route, req.body), req.ip);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    const run = (tx: Tx) => handler({ ...base, tx });
    return isPlatformPath ? db.platform(run) : db.api(null, run);
  }

  const claims = bearer(req, services.config.jwtSecret);

  if (route.auth === 'platform') {
    if (claims.client !== 'webAdmin' || !claims.prole) throw new ApiError('forbidden', 'Console staff only.');
    return db.platform(async (tx) => {
      const staff = await loadStaff(tx, claims.sub, claims.sid);
      if (services.config.requirePlatformTotp && !staff.totpOn && !TOTP_SETUP_ROUTES.has(route.key)) {
        throw new ApiError('forbidden', 'Turn on two-factor sign-in first.', { reason: 'totpSetupRequired' });
      }
      if (route.platformRole === 'admin' && staff.role !== 'admin') {
        throw new ApiError('forbidden', 'Console admins only.', { platformRole: 'admin' });
      }
      const result = await handler({ ...base, tx, claims, staff });
      if (route.method !== 'GET') {
        await writeAudit(tx, req, route, { kind: 'platform', staff }, note);
      }
      return result;
    });
  }

  if (claims.client === 'webAdmin' && route.auth === 'member') {
    throw new ApiError('forbidden', 'Console tokens do not act in a property.');
  }

  return db.api(claims.pid, async (tx) => {
    const member = claims.mid ? await loadMember(tx, claims, route.action ?? null) : null;
    const assertCan = (action: ActionKey) => checkAction(tx, member, action);
    if (member) gate(member, route);

    if (route.auth === 'session') {
      if (!member) await gatePasswordForUser(tx, claims.sub, route);
      return handler({ ...base, tx, claims, member, assertCan });
    }

    // route.auth === 'member'
    const m = requireMember(member);
    refuseUnless(m, route.action!);

    const key = req.headers['idempotency-key'];
    const idempotent = typeof key === 'string' && route.method !== 'GET';
    if (idempotent) {
      const earlier = await claimIdempotencyKey(tx, m, route, key);
      if (earlier) return new Replay(earlier.status_code, earlier.response);
    }

    const changed = (table: string, ids: number[]) =>
      tx.afterCommit(() => services.events.emit(m.propertyId, { table, ids }));
    const result = await handler({ ...base, tx, claims, member: m, assertCan, changed });

    if (idempotent && !reply.sent) {
      await tx.exec(
        `update idempotency_keys set status_code = $3, response = $4 where member_id = $1 and key = $2`,
        [m.memberId, key, result == null ? 204 : 200, result == null ? null : JSON.stringify(result)],
      );
    }
    if (route.destructive || (note as AuditNote | null)?.force) {
      await writeAudit(tx, req, route, { kind: 'member', member: m }, note);
    }
    return result;
  });
}

const MEMBER_SQL = `
  select m.id as "memberId", m.user_id as "userId", m.property_id as "propertyId",
         m.role, m.is_owner as "isOwner", m.staff_id as "staffId", m.status as "memberStatus",
         u.display_name as "displayName", u.status as "userStatus",
         u.must_change_password as "mustChangePassword",
         p.status as "propertyStatus", p.timezone, p.code::text as "propertyCode",
         coalesce((select json_object_agg(g.module, g.level)
                   from member_module_access g where g.member_id = m.id), '{}'::json) as grants,
         fn_member_can(m.id, $4::text) as allowed,
         fn_member_can(m.id, 'payroll.view') as "canSeePay",
         -- the token's family still has a live session (refresh rotates the row, so not its own id)
         exists (select 1 from auth_sessions cur join auth_sessions own on own.family_id = cur.family_id
                 where own.id = $5::uuid and own.user_id = m.user_id and cur.revoked_at is null) as "sessionLive"
  from property_members m
  join users u on u.id = m.user_id
  join properties p on p.id = m.property_id
  where m.id = $1 and m.user_id = $2 and m.property_id = $3`;

/** The member a session route acts as; 403 before a property is chosen. */
export function requireMember(member: Member | null): Member {
  if (!member) throw new ApiError('forbidden', 'Choose a property first.', { reason: 'noPropertySelected' });
  return member;
}

async function loadMember(tx: Tx, claims: AccessClaims, action: ActionKey | null): Promise<Member> {
  const m = await tx.one<Member & { allowed: boolean | null; sessionLive: boolean }>(
    MEMBER_SQL, [claims.mid, claims.sub, claims.pid, action, claims.sid]);
  // Gone, or switched off: the app should sign out.
  if (!m || m.memberStatus !== 'active' || m.userStatus !== 'active') {
    throw new ApiError('unauthenticated', 'This sign-in is no longer valid.');
  }
  // After the status gate's first answer: a suspended unit ends its sessions too, and
  // its members should hear property_suspended, not a bare sign-out.
  if (!m.sessionLive && m.propertyStatus === 'active') {
    throw new ApiError('unauthenticated', 'This sign-in is no longer valid.');
  }
  return m;
}

/** Statuses and the temporary-password gate, before any action check. */
function gate(member: Member, route: RouteInfo): void {
  if (member.propertyStatus !== 'active') {
    throw new ApiError('property_suspended', 'This unit is not active.');
  }
  if (member.mustChangePassword && !route.path.startsWith('/v1/auth/') && route.path !== '/v1/me') {
    throw new ApiError('password_change_required', 'Change the temporary password first.');
  }
}

async function gatePasswordForUser(tx: Tx, userId: number, route: RouteInfo): Promise<void> {
  if (route.path.startsWith('/v1/auth/') || route.path === '/v1/me') return;
  const u = await tx.one(`select must_change_password from users where id = $1`, [userId]);
  if (u?.must_change_password) throw new ApiError('password_change_required', 'Change the temporary password first.');
}

async function checkAction(tx: Tx, member: Member | null, action: ActionKey): Promise<void> {
  if (!member) throw new ApiError('forbidden', 'Choose a property first.', { reason: 'noPropertySelected' });
  const row = await tx.one<{ allowed: boolean }>(`select fn_member_can($1, $2) as allowed`, [member.memberId, action]);
  refuseUnless(member, action, row?.allowed);
}

/** Throws the 403 that explains a "no" (the flag is fn_member_can's answer, already in the member row by default). */
function refuseUnless(member: Member, action: ActionKey, allowed: boolean | null | undefined = (member as any).allowed): void {
  if (allowed) return;
  const code = refusal({
    role: member.role,
    isOwner: member.isOwner,
    status: member.memberStatus,
    userStatus: member.userStatus,
    propertyStatus: member.propertyStatus,
    grants: member.grants as never,
  }, action) ?? 'forbidden';
  throw new ApiError(code, `Not allowed: ${action}.`, { action });
}

async function loadStaff(tx: Tx, userId: number, sid: string): Promise<PlatformStaff & { totpOn: boolean }> {
  const s = await tx.one<PlatformStaff & { status: string; must_change_password: boolean; sessionLive: boolean; totpOn: boolean }>(
    `select ps.user_id as "userId", ps.role, ps.totp_enabled_at is not null as "totpOn", u.status, u.must_change_password,
            exists (select 1 from auth_sessions cur join auth_sessions own on own.family_id = cur.family_id
                    where own.id = $2::uuid and own.user_id = ps.user_id and cur.revoked_at is null) as "sessionLive"
     from platform_staff ps join users u on u.id = ps.user_id where ps.user_id = $1`,
    [userId, sid],
  );
  if (!s || s.status !== 'active' || !s.sessionLive) throw new ApiError('unauthenticated', 'This sign-in is no longer valid.');
  if (s.must_change_password) throw new ApiError('password_change_required', 'Change the temporary password first.');
  return { userId: s.userId, role: s.role, totpOn: s.totpOn };
}

/** Claims the key, or returns the response already stored under it. */
async function claimIdempotencyKey(tx: Tx, member: Member, route: RouteInfo, key: string) {
  if (key.length < 8 || key.length > 100) {
    throw new ApiError('validation_failed', 'Bad Idempotency-Key.', { fields: { 'Idempotency-Key': 'length' } });
  }
  const claimed = await tx.exec(
    `insert into idempotency_keys (property_id, member_id, key, route)
     values ($1, $2, $3, $4) on conflict do nothing`,
    [member.propertyId, member.memberId, key, route.key],
  );
  if (claimed) return null;
  const row = await tx.one<{ route: string; status_code: number; response: unknown; fresh: boolean }>(
    `select route, status_code, response, created_at > now() - interval '24 hours' as fresh
     from idempotency_keys where member_id = $1 and key = $2`,
    [member.memberId, key],
  );
  if (!row || row.status_code == null) return null;
  if (row.route !== route.key) {
    throw new ApiError('validation_failed', 'Idempotency-Key reused on another route.', {
      fields: { 'Idempotency-Key': 'reused' },
    });
  }
  if (!row.fresh) {
    // Past 24 hours the key starts over.
    await tx.exec(
      `update idempotency_keys set created_at = now(), status_code = null, response = null
       where member_id = $1 and key = $2`,
      [member.memberId, key],
    );
    return null;
  }
  return row;
}

type Actor = { kind: 'member'; member: Member } | { kind: 'platform'; staff: PlatformStaff };

async function writeAudit(tx: Tx, req: FastifyRequest, route: RouteInfo, actor: Actor, note: AuditNote | null) {
  const params = req.params as Record<string, unknown>;
  const entityId = note?.entityId ?? params.id ?? params.memberId ?? null;
  const entityType = note?.entityType ?? route.path.split('/')[actor.kind === 'platform' ? 3 : 2];
  const action = note?.action ?? route.action ?? `platform.${route.method.toLowerCase()} ${route.path.slice(12)}`;
  const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  const propertyId = actor.kind === 'member'
    ? actor.member.propertyId
    : note?.propertyId ?? (route.path.startsWith('/v1/platform/properties/:id') ? params.id : null);
  await tx.exec(
    `insert into audit_log (property_id, actor_user_id, actor_member_id, actor_platform_role,
                            action, entity_type, entity_id, destructive, before, after,
                            request_id, ip, user_agent)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      propertyId,
      actor.kind === 'member' ? actor.member.userId : actor.staff.userId,
      actor.kind === 'member' ? actor.member.memberId : null,
      actor.kind === 'platform' ? actor.staff.role : null,
      action,
      entityType,
      entityId === null ? null : String(entityId),
      route.destructive,
      json(note?.before),
      json(note?.after),
      req.id,
      req.ip,
      req.headers['user-agent'] ?? null,
    ],
  );
}
