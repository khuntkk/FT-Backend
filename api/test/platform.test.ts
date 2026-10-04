import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { todayIn } from '@stitchflow/contract';
import { hashPassword } from '../src/auth/passwords.ts';
import {
  Client, PASSWORD, seedProperty, signIn, signInAll, startHarness, type Harness, type SeededProperty,
} from './helpers.ts';

let h: Harness;
let p: SeededProperty;
let as: Record<string, Client>;
let admin: Client;
let support: Client;
let adminId: number;
let supportId: number;

/** Console staff made directly, as the create-platform-admin script would. */
async function makeStaff(email: string, role: 'admin' | 'support'): Promise<number> {
  const [{ id }] = await h.sql(
    `insert into users (display_name, email, password_hash, must_change_password)
     values ($1, $2, $3, false) returning id`,
    [`${role} person`, email, await hashPassword(PASSWORD)],
  );
  await h.sql(`insert into platform_staff (user_id, role) values ($1, $2)`, [id, role]);
  return id;
}

async function consoleSignIn(email: string, password = PASSWORD): Promise<Client> {
  const c = new Client(h.app);
  const res = await c.post('/v1/platform/auth/login', { email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  c.token = res.body.accessToken;
  c.refreshToken = res.body.refreshToken;
  return c;
}

const refreshFails = async (c: Client) => {
  const res = await new Client(h.app).post('/v1/auth/refresh', { refreshToken: c.refreshToken });
  assert.equal(res.status, 401);
};

before(async () => {
  h = await startHarness();
  p = await seedProperty(h);
  as = await signInAll(h, p);
  adminId = await makeStaff('admin@stitchflow.test', 'admin');
  supportId = await makeStaff('support@stitchflow.test', 'support');
  admin = await consoleSignIn('admin@stitchflow.test');
  support = await consoleSignIn('support@stitchflow.test');
});
after(() => h.close());

const OWNER_PHONE = '+919800000001';
const newProperty = (over: Record<string, unknown> = {}) => ({
  code: 'janki-creation', name: 'Janki Creation', timezone: 'Asia/Kolkata', machineLimit: 3,
  owner: { displayName: 'Janki Owner', phone: OWNER_PHONE, email: 'janki@example.com' },
  ...over,
});

describe('who may call the console', () => {
  it('refuses no token, and an app token', async () => {
    assert.equal((await new Client(h.app).get('/v1/platform/properties')).status, 401);
    const res = await as.superAdmin.get('/v1/platform/properties');
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
  });

  it('lets support read but not change', async () => {
    assert.equal((await support.get('/v1/platform/properties')).status, 200);
    for (const res of [
      await support.post('/v1/platform/properties', newProperty()),
      await support.patch(`/v1/platform/properties/${p.propertyId}`, { machineLimit: 1 }),
      await support.post(`/v1/platform/properties/${p.propertyId}/transfer-ownership`, { toMemberId: 1 }),
      await support.post(`/v1/platform/users/${p.members.worker.userId}/disable`),
      await support.post(`/v1/platform/users/${p.members.worker.userId}/enable`),
      await support.get('/v1/platform/staff'),
      await support.post('/v1/platform/staff', { displayName: 'X', email: 'x@y.zz', role: 'admin' }),
      await support.del(`/v1/platform/staff/${adminId}`),
    ]) {
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'forbidden');
      assert.equal(res.body.error.details.platformRole, 'admin');
    }
  });

  it('a console token does not act in a property', async () => {
    const res = await admin.get('/v1/machines');
    assert.equal(res.status, 403);
  });
});

let created: any;
let owner: Client;

describe('creating a property', () => {
  it('names each bad field', async () => {
    const res = await admin.post('/v1/platform/properties', newProperty({
      code: 'Bad Code', timezone: 'Mars/Olympus', machineLimit: 10000,
      owner: { displayName: 'X', phone: '98000', email: 'nope' },
    }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.deepEqual(res.body.error.details.fields, {
      code: 'pattern', timezone: 'unknown', machineLimit: 'range', 'owner.phone': 'pattern', 'owner.email': 'pattern',
    });
  });

  it('creates the property, settings, shifts and owner, with a temporary password', async () => {
    const res = await admin.post('/v1/platform/properties', newProperty());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    created = res.body;
    assert.equal(created.property.code, 'janki-creation');
    assert.equal(created.property.machineLimit, 3);
    assert.equal(created.property.status, 'active');
    assert.equal(created.owner.role, 'superAdmin');
    assert.equal(created.owner.isOwner, true);
    assert.equal(created.temporaryPassword.length, 10);

    const id = created.property.id;
    const [settings] = await h.sql(`select * from property_settings where property_id = $1`, [id]);
    assert.equal(settings.business_name, 'Janki Creation');
    const shifts = await h.sql(
      `select name, start_minute, duration_minutes, sort_order, effective_from::text as "from"
       from shifts where property_id = $1 order by sort_order`, [id]);
    const today = todayIn('Asia/Kolkata');
    assert.deepEqual(shifts, [
      { name: 'Day', start_minute: 480, duration_minutes: 720, sort_order: 0, from: today },
      { name: 'Night', start_minute: 1200, duration_minutes: 720, sort_order: 1, from: today },
    ]);
    const [user] = await h.sql(`select must_change_password, email::text from users where phone = $1`, [OWNER_PHONE]);
    assert.deepEqual(user, { must_change_password: true, email: 'janki@example.com' });
  });

  it('refuses a taken code', async () => {
    const res = await admin.post('/v1/platform/properties', newProperty({ owner: { displayName: 'Y', phone: '+919800000099' } }));
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.error.details.fields, { code: 'taken' });
  });

  it('the owner signs in with it and must change it first', async () => {
    owner = await signIn(h, OWNER_PHONE, created.temporaryPassword);
    const blocked = await owner.get('/v1/machines');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'password_change_required');
    const changed = await owner.post('/v1/auth/change-password', { current: created.temporaryPassword, next: 'owner-pass-77' });
    assert.equal(changed.status, 204);
    assert.equal((await owner.get('/v1/machines')).status, 200);
  });

  it('the machine limit set here holds', async () => {
    assert.deepEqual((await owner.post('/v1/machines/bulk', { upTo: 3 })).body, { created: 3 });
    const res = await owner.post('/v1/machines', { number: 4 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'machine_limit_reached');
    assert.deepEqual(res.body.error.details, { limit: 3, used: 3 });
  });

  it('an existing user (same phone) is made owner and keeps their own password', async () => {
    const res = await admin.post('/v1/platform/properties', newProperty({
      code: 'janki-two', name: 'Janki Two', timezone: 'Europe/London', machineLimit: 0,
    }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.temporaryPassword, '');
    assert.equal(res.body.owner.userId, created.owner.userId);
    const [{ n }] = await h.sql(`select count(*)::int as n from property_members where user_id = $1`, [created.owner.userId]);
    assert.equal(n, 2);
    assert.equal((await signIn(h, OWNER_PHONE, 'owner-pass-77')).token !== null, true);
  });

  it('an existing user with no password yet gets a temporary one', async () => {
    await h.sql(`insert into users (display_name, phone) values ('Invited', '+919800000002')`);
    const res = await admin.post('/v1/platform/properties', newProperty({
      code: 'invited-unit', name: 'Invited Unit', owner: { displayName: 'Invited', phone: '+919800000002' },
    }));
    assert.equal(res.status, 200);
    assert.equal(res.body.temporaryPassword.length, 10);
  });
});

describe('reading properties', () => {
  it('lists with counts, searchable by name or code and status', async () => {
    const res = await support.get('/v1/platform/properties', { query: 'JANKI' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((x: any) => x.code), ['janki-creation', 'janki-two']);
    const [first] = res.body;
    assert.equal(first.memberCount, 1);
    assert.equal(first.machineCount, 3);
    assert.equal(first.machineLimit, 3);
    assert.match(first.lastActivityAt, /Z$/);
    assert.equal(res.body[1].lastActivityAt, null);

    const byCode = await support.get('/v1/platform/properties', { query: 'invited-u' });
    assert.deepEqual(byCode.body.map((x: any) => x.code), ['invited-unit']);
    const suspended = await support.get('/v1/platform/properties', { status: 'suspended' });
    assert.deepEqual(suspended.body, []);
  });

  it('shows one property: members, counts, settings', async () => {
    const res = await support.get(`/v1/platform/properties/${p.propertyId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.property.id, p.propertyId);
    assert.equal(res.body.settings.businessName, p.code.replace('unit-', 'Unit '));
    assert.equal(res.body.members.length, 6);
    assert.equal(res.body.members[0].isOwner, true);
    assert.ok(Array.isArray(res.body.members[0].modules));
    assert.equal(res.body.machineCount, 0);
    assert.equal(res.body.staffCount, 0);
    assert.equal((await support.get('/v1/platform/properties/999999')).status, 404);
  });
});

describe('changing a property', () => {
  it('lowers the machine limit below what the unit has, removing nothing', async () => {
    const res = await admin.patch(`/v1/platform/properties/${created.property.id}`, { machineLimit: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.body.machineLimit, 1);
    assert.deepEqual((await owner.get('/v1/machines/allowance')).body, { limit: 1, used: 3, left: 0 });
    assert.equal((await owner.get('/v1/machines')).body.length, 3);
    const more = await owner.post('/v1/machines', { number: 9 });
    assert.equal(more.status, 409);
    assert.deepEqual(more.body.error.details, { limit: 1, used: 3 });
  });

  it('refuses bad values', async () => {
    const res = await admin.patch(`/v1/platform/properties/${created.property.id}`, {
      timezone: 'Nowhere/Land', machineLimit: -1, name: ' ',
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.deepEqual(res.body.error.details.fields, { timezone: 'unknown', machineLimit: 'range', name: 'length' });
    assert.equal((await admin.patch('/v1/platform/properties/999999', { name: 'X' })).status, 404);
  });

  it('suspending ends the members\' sessions; reactivating lets them back', async () => {
    const res = await admin.patch(`/v1/platform/properties/${created.property.id}`, { status: 'suspended' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'suspended');
    const blocked = await owner.get('/v1/machines');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'property_suspended');
    await refreshFails(owner);

    await admin.patch(`/v1/platform/properties/${created.property.id}`, { status: 'active', name: 'Janki Creations' });
    // Two memberships now, so sign-in leaves the choice to select-property.
    owner = await signIn(h, OWNER_PHONE, 'owner-pass-77');
    const pick = await owner.post('/v1/auth/select-property', { memberId: created.owner.id });
    assert.equal(pick.status, 200);
    owner.token = pick.body.accessToken;
    assert.equal((await owner.get('/v1/machines')).status, 200);
  });

  it('transfers ownership to another super admin only', async () => {
    const url = `/v1/platform/properties/${p.propertyId}/transfer-ownership`;
    const notSuper = await admin.post(url, { toMemberId: p.members.admin.memberId });
    assert.equal(notSuper.status, 400);
    assert.deepEqual(notSuper.body.error.details.fields, { toMemberId: 'notSuperAdmin' });
    const elsewhere = await admin.post(url, { toMemberId: created.owner.id });
    assert.equal(elsewhere.status, 404);

    assert.equal((await admin.post(url, { toMemberId: p.members.superAdmin2.memberId })).status, 204);
    const owners = await h.sql(`select id from property_members where property_id = $1 and is_owner`, [p.propertyId]);
    assert.deepEqual(owners.map((r) => r.id), [p.members.superAdmin2.memberId]);
    const [audit] = await h.sql(
      `select before, after from audit_log where action like '%transfer-ownership' and property_id = $1`, [p.propertyId]);
    assert.deepEqual(audit, {
      before: { ownerMemberId: p.members.superAdmin.memberId }, after: { ownerMemberId: p.members.superAdmin2.memberId },
    });
  });
});

describe('users', () => {
  it('finds anyone by phone, email, username or name', async () => {
    const byPhone = await support.get('/v1/platform/users', { query: '9800000001' });
    assert.equal(byPhone.status, 200);
    assert.equal(byPhone.body.length, 1);
    const [u] = byPhone.body;
    assert.equal(u.user.phone, OWNER_PHONE);
    assert.equal(u.user.passwordHash, undefined);
    assert.deepEqual(u.memberships.map((m: any) => m.propertyCode).sort(), ['janki-creation', 'janki-two']);
    assert.ok(u.liveSessions >= 1);
    assert.match(u.user.lastLoginAt, /Z$/);

    assert.equal((await support.get('/v1/platform/users', { query: 'JANKI@example' })).body.length, 1);
    assert.equal((await support.get('/v1/platform/users', { query: p.members.worker.username })).body.length, 1);
    assert.equal((await support.get('/v1/platform/users', { query: 'Janki Owner' })).body.length, 1);
    assert.deepEqual((await support.get('/v1/platform/users', { query: '%' })).body, []);
  });

  it('shows one user', async () => {
    const res = await support.get(`/v1/platform/users/${p.members.worker.userId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.memberships[0].role, 'worker');
    assert.equal(res.body.liveSessions, 1);
    assert.equal((await support.get('/v1/platform/users/999999')).status, 404);
  });

  it('support resets a unit user\'s password, ending their sessions', async () => {
    const worker = as.worker;
    const res = await support.post(`/v1/platform/users/${p.members.worker.userId}/reset-password`);
    assert.equal(res.status, 200);
    assert.equal(res.body.temporaryPassword.length, 10);
    await refreshFails(worker);
    const again = await signIn(h, p.members.worker.username, res.body.temporaryPassword);
    const blocked = await again.get('/v1/machines');
    assert.equal(blocked.body.error.code, 'password_change_required');
  });

  it('support cannot reset a console admin\'s password', async () => {
    const res = await support.post(`/v1/platform/users/${adminId}/reset-password`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.details.platformRole, 'admin');
  });

  it('an admin switches a user off everywhere and back on', async () => {
    const viewAdmin = as.viewAdmin;
    const off = await admin.post(`/v1/platform/users/${p.members.viewAdmin.userId}/disable`);
    assert.equal(off.status, 200);
    assert.equal(off.body.status, 'disabled');
    await refreshFails(viewAdmin);
    assert.equal((await viewAdmin.get('/v1/machines')).status, 401);
    const login = await new Client(h.app).post('/v1/auth/login', {
      identifier: p.members.viewAdmin.username, password: PASSWORD, client: 'managerApp', keepSignedIn: false,
    });
    assert.equal(login.status, 401);

    const on = await admin.post(`/v1/platform/users/${p.members.viewAdmin.userId}/enable`);
    assert.equal(on.body.status, 'active');
    await signIn(h, p.members.viewAdmin.username);
  });

  it('an admin cannot switch themselves off', async () => {
    const res = await admin.post(`/v1/platform/users/${adminId}/disable`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.error.details.fields, { id: 'self' });
  });

  it('support signs a user out everywhere', async () => {
    const supervisor = as.supervisor;
    assert.equal((await support.del(`/v1/platform/users/${p.members.supervisor.userId}/sessions`)).status, 204);
    await refreshFails(supervisor);
    const u = await support.get(`/v1/platform/users/${p.members.supervisor.userId}`);
    assert.equal(u.body.liveSessions, 0);
    assert.equal((await support.del('/v1/platform/users/999999/sessions')).status, 404);
  });
});

describe('our console staff', () => {
  let newcomer: Client;
  let newcomerId: number;

  it('lists them, admin only', async () => {
    const res = await admin.get('/v1/platform/staff');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((s: any) => [s.email, s.role]).sort(), [
      ['admin@stitchflow.test', 'admin'], ['support@stitchflow.test', 'support'],
    ]);
  });

  it('adds one with a temporary password they must change', async () => {
    const res = await admin.post('/v1/platform/staff', { displayName: 'New Support', email: 'new@stitchflow.test', role: 'support' });
    assert.equal(res.status, 200);
    assert.equal(res.body.staff.role, 'support');
    newcomerId = res.body.staff.userId;
    const again = await admin.post('/v1/platform/staff', { displayName: 'New', email: 'NEW@stitchflow.test', role: 'admin' });
    assert.equal(again.status, 400);
    assert.deepEqual(again.body.error.details.fields, { email: 'alreadyStaff' });

    newcomer = await consoleSignIn('new@stitchflow.test', res.body.temporaryPassword);
    const blocked = await newcomer.get('/v1/platform/properties');
    assert.equal(blocked.body.error.code, 'password_change_required');
    const changed = await newcomer.post('/v1/auth/change-password', { current: res.body.temporaryPassword, next: 'console-pass-1' });
    assert.equal(changed.status, 204);
    assert.equal((await newcomer.get('/v1/platform/properties')).status, 200);
  });

  it('an admin cannot remove themselves', async () => {
    const res = await admin.del(`/v1/platform/staff/${adminId}`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.error.details.fields, { id: 'self' });
  });

  it('removes one, ending their console sessions; the user stays', async () => {
    assert.equal((await admin.del(`/v1/platform/staff/${newcomerId}`)).status, 204);
    assert.equal((await newcomer.get('/v1/platform/properties')).status, 401);
    await refreshFails(newcomer);
    assert.equal((await h.sql(`select 1 from users where id = $1`, [newcomerId])).length, 1);
    assert.equal((await admin.del(`/v1/platform/staff/${newcomerId}`)).status, 404);
  });
});

describe('the audit log', () => {
  it('has a row for every console change, with the platform role', async () => {
    const rows = await h.sql(
      `select action, actor_user_id, actor_platform_role, entity_type, property_id, after
       from audit_log where actor_platform_role is not null order by id`);
    const created = rows.find((r) => r.action === 'platform.post /properties');
    assert.ok(created);
    assert.equal(created.actor_platform_role, 'admin');
    assert.equal(created.actor_user_id, adminId);
    assert.equal(created.entity_type, 'property');
    assert.ok(created.property_id);
    const reset = rows.find((r) => r.action === 'platform.post /users/:id/reset-password');
    assert.equal(reset.actor_platform_role, 'support');
    assert.equal(reset.actor_user_id, supportId);
    assert.ok(!JSON.stringify(rows).includes('temporaryPassword'));
  });

  it('pages newest first, filtered', async () => {
    const all = await support.get('/v1/platform/audit', { actorUserId: String(adminId) });
    assert.equal(all.status, 200);
    assert.ok(all.body.items.length >= 5);
    assert.equal(all.body.nextCursor, null);
    assert.ok(all.body.items.every((a: any) => a.actorPlatformRole === 'admin'));
    assert.match(all.body.items[0].occurredAt, /Z$/);

    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const query: Record<string, string> = { actorUserId: String(adminId), limit: '2' };
      if (cursor) query.cursor = cursor;
      const page: any = await support.get('/v1/platform/audit', query);
      assert.ok(page.body.items.length <= 2);
      seen.push(...page.body.items.map((a: any) => a.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, all.body.items.map((a: any) => a.id));
    assert.deepEqual(seen, [...seen].sort((a, b) => b - a));
  });

  it('filters by property, date and destructive', async () => {
    const id = String(created.property.id);
    const forProperty = await support.get('/v1/platform/audit', { propertyId: id });
    assert.ok(forProperty.body.items.length >= 3);
    assert.ok(forProperty.body.items.every((a: any) => a.propertyId === created.property.id));
    const limitChange = forProperty.body.items.find((a: any) => a.after?.machineLimit === 1 && a.before?.machineLimit === 3);
    assert.ok(limitChange);

    const today = new Date().toISOString().slice(0, 10);
    assert.equal((await support.get('/v1/platform/audit', { propertyId: id, from: today, to: today })).body.items.length,
      forProperty.body.items.length);
    assert.deepEqual((await support.get('/v1/platform/audit', { propertyId: id, to: '2026-01-01' })).body.items, []);
    assert.deepEqual((await support.get('/v1/platform/audit', { propertyId: id, destructive: 'true' })).body.items, []);
  });

  it('refuses a bad limit or cursor', async () => {
    const big = await support.get('/v1/platform/audit', { limit: '501' });
    assert.equal(big.status, 400);
    const bad = await support.get('/v1/platform/audit', { cursor: 'not-a-cursor' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.error.details.fields, { cursor: 'invalid' });
  });
});
