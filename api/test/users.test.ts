import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, seedProperty, signIn, signInAll, startHarness, type Harness, type SeededProperty } from './helpers.ts';

let h: Harness;
let p: SeededProperty;
let as: Record<string, Client>;
let n = 0;

before(async () => {
  h = await startHarness();
  p = await seedProperty(h);
  as = await signInAll(h, p);
});
after(() => h.close());

const uniqueName = (prefix: string) => `u-${prefix}-${++n}`.toLowerCase();

/** Adds a user as `by`; returns the response. */
const add = (by: Client, role: string, extra: Record<string, unknown> = {}) =>
  by.post('/v1/users', { displayName: `New ${role}`, username: uniqueName(role), role, ...extra });

/** A new member who has chosen their own password, signed in. */
async function newMember(role: string, by = as.superAdmin) {
  const username = uniqueName(`m-${role}`);
  const res = await by.post('/v1/users', { displayName: `Member ${role}`, username, role });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await h.sql(`update users set must_change_password = false where id = $1`, [res.body.member.userId]);
  const c = await signIn(h, username, res.body.temporaryPassword);
  return { member: res.body.member, client: c, username, password: res.body.temporaryPassword as string };
}

describe('listing users', () => {
  it('lists every member with role, owner flag and module levels, never a hash', async () => {
    const res = await as.viewAdmin.get('/v1/users');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 6);
    assert.equal(res.body[0].id, p.members.superAdmin.memberId);
    assert.equal(res.body[0].isOwner, true);
    const admin = res.body.find((m: any) => m.id === p.members.admin.memberId);
    assert.equal(admin.role, 'admin');
    assert.equal(admin.status, 'active');
    assert.deepEqual(admin.modules.find((x: any) => x.module === 'settings'), { module: 'settings', level: 'view' });
    assert.ok(!JSON.stringify(res.body).toLowerCase().includes('password'));
  });

  it('is refused to an operator', async () => {
    const res = await as.worker.get('/v1/users');
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
  });
});

describe('who creates whom (HANDOVER §6)', () => {
  const roles = ['superAdmin', 'admin', 'viewAdmin', 'supervisor', 'worker'];
  const table: Record<string, string[]> = {
    superAdmin: roles, // the owner
    superAdmin2: ['admin', 'viewAdmin', 'supervisor', 'worker'],
    admin: ['viewAdmin', 'supervisor', 'worker'],
    supervisor: ['worker'],
    viewAdmin: [],
    worker: [],
  };
  for (const [creator, may] of Object.entries(table)) {
    it(`${creator} creates ${may.join(', ') || 'nobody'}`, async () => {
      for (const role of roles) {
        const res = await add(as[creator], role);
        if (may.includes(role)) {
          assert.equal(res.status, 200, `${creator} → ${role}: ${JSON.stringify(res.body)}`);
          assert.equal(res.body.member.role, role);
        } else {
          assert.equal(res.status, 403, `${creator} → ${role}`);
          assert.equal(res.body.error.code, 'forbidden');
          assert.equal(res.body.error.details.action, 'users.create');
        }
      }
    });
  }

  it('gives a new user a temporary password that must be changed first', async () => {
    const username = uniqueName('temp');
    const res = await as.supervisor.post('/v1/users', { displayName: 'Op', username, role: 'worker' });
    assert.equal(res.status, 200);
    assert.equal(res.body.temporaryPassword.length, 10);
    assert.equal(res.body.member.isOwner, false);
    const [u] = await h.sql(`select must_change_password, password_hash from users where id = $1`, [res.body.member.userId]);
    assert.equal(u.must_change_password, true);
    assert.match(u.password_hash, /^\$argon2id\$/);
    const c = await signIn(h, username, res.body.temporaryPassword);
    const gated = await c.get('/v1/machines');
    assert.equal(gated.status, 403);
    assert.equal(gated.body.error.code, 'password_change_required');
    const [audit] = await h.sql(`select * from audit_log where action = 'users.create' and entity_id = $1`,
      [String(res.body.member.id)]);
    assert.equal(audit.after.role, 'worker');
  });

  it('refuses modules above the granter or above the role\'s ceiling', async () => {
    const ceiling = await add(as.supervisor, 'worker', { modules: { machines: 'edit' } });
    assert.equal(ceiling.status, 409);
    assert.equal(ceiling.body.error.code, 'grant_exceeds_granter');
    assert.equal(ceiling.body.error.details.module, 'machines');

    const payroll = await add(as.admin, 'viewAdmin', { modules: { payroll: 'edit' } });
    assert.equal(payroll.body.error.code, 'grant_exceeds_granter');

    // Cut the supervisor's own production to view: they cannot give edit.
    const cut = await as.admin.patch(`/v1/users/${p.members.supervisor.memberId}/access`, { modules: { production: 'view' } });
    assert.equal(cut.status, 200);
    assert.equal(cut.body.modules.find((x: any) => x.module === 'production').level, 'view');
    const over = await add(as.supervisor, 'worker', { modules: { production: 'edit' } });
    assert.equal(over.status, 409);
    assert.deepEqual(over.body.error.details, { module: 'production', level: 'edit' });
    const within = await add(as.supervisor, 'worker', { modules: { production: 'view', attendance: 'none' } });
    assert.equal(within.status, 200);
    const levels = Object.fromEntries(within.body.member.modules.map((x: any) => [x.module, x.level]));
    assert.equal(levels.production, 'view');
    assert.equal(levels.attendance, 'none');
    assert.equal(levels.machines, 'view');
    await as.admin.patch(`/v1/users/${p.members.supervisor.memberId}/access`, { modules: { production: 'edit' } });
  });

  it('links a supervisor\'s operator to a live roster row', async () => {
    const [{ id: staffId }] = await h.sql(
      `insert into staff (property_id, name) values ($1, 'Kishor') returning id`, [p.propertyId]);
    const res = await add(as.supervisor, 'worker', { staffId });
    assert.equal(res.status, 200);
    assert.equal(res.body.member.staffId, staffId);
    await h.sql(`update staff set deleted_at = now() where id = $1`, [staffId]);
    assert.equal((await add(as.supervisor, 'worker', { staffId })).status, 404);
  });

  it('adds an existing user (same phone) as a member instead of a second login', async () => {
    const other = await seedProperty(h);
    const phone = '+919812345601';
    const [{ id: userId }] = await h.sql(`update users set phone = $1 where id = $2 returning id`,
      [phone, other.members.admin.userId]);
    const res = await as.superAdmin.post('/v1/users', { displayName: 'Same person', phone, role: 'admin' });
    assert.equal(res.status, 200);
    assert.equal(res.body.member.userId, userId);
    // They keep their own password; nothing is reset under them.
    assert.equal(res.body.temporaryPassword, '');
    await signIn(h, other.members.admin.username);

    const again = await as.superAdmin.post('/v1/users', { displayName: 'Again', phone, role: 'worker' });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'validation_failed');
    assert.equal(again.body.error.details.fields.phone, 'alreadyMember');
  });

  it('wants a sign-in, and a valid one', async () => {
    const none = await as.admin.post('/v1/users', { displayName: 'Nobody', role: 'worker' });
    assert.equal(none.status, 400);
    assert.equal(none.body.error.details.fields.phone, 'required');
    const bad = await as.admin.post('/v1/users', { displayName: 'Bad', phone: '98123', role: 'worker' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.details.fields.phone, 'pattern');
  });
});

describe('managing a member', () => {
  it('lets a creator manage only who they could create, and nobody the owner', async () => {
    const res = await as.admin.patch(`/v1/users/${p.members.superAdmin2.memberId}/access`, { modules: { production: 'view' } });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
    const sup = await as.supervisor.post(`/v1/users/${p.members.admin.memberId}/reset-password`);
    assert.equal(sup.status, 403);
    const owner = await as.superAdmin2.post(`/v1/users/${p.members.superAdmin.memberId}/disable`);
    assert.equal(owner.status, 403);
    assert.equal(owner.body.error.code, 'forbidden');
    const self = await as.superAdmin.post(`/v1/users/${p.members.superAdmin.memberId}/disable`);
    assert.equal(self.status, 403);
  });

  it('resets a password: shown once, must be changed, old sessions end', async () => {
    const { member, client, username } = await newMember('worker', as.supervisor);
    const res = await as.supervisor.post(`/v1/users/${member.id}/reset-password`);
    assert.equal(res.status, 200);
    assert.equal(res.body.temporaryPassword.length, 10);
    assert.equal((await client.post('/v1/auth/refresh', { refreshToken: client.refreshToken })).status, 401);
    const fresh = await signIn(h, username, res.body.temporaryPassword);
    assert.equal((await fresh.get('/v1/machines')).body.error.code, 'password_change_required');
  });

  it('switches a member off: their very next request is refused; and back on', async () => {
    const { member, client, username, password } = await newMember('supervisor', as.admin);
    assert.equal((await client.get('/v1/machines')).status, 200);
    const off = await as.admin.post(`/v1/users/${member.id}/disable`);
    assert.equal(off.status, 200);
    assert.equal(off.body.status, 'disabled');
    const next = await client.get('/v1/machines');
    assert.equal(next.status, 401);
    assert.equal(next.body.error.code, 'unauthenticated');
    assert.equal((await client.post('/v1/auth/refresh', { refreshToken: client.refreshToken })).status, 401);
    const [live] = await h.sql(`select count(*)::int as n from auth_sessions where member_id = $1 and revoked_at is null`, [member.id]);
    assert.equal(live.n, 0);

    const on = await as.admin.post(`/v1/users/${member.id}/enable`);
    assert.equal(on.body.status, 'active');
    const again = await signIn(h, username, password);
    assert.equal((await again.get('/v1/machines')).status, 200);
  });

  it('removes a member for a super admin only; the user stays', async () => {
    const { member } = await newMember('worker', as.admin);
    const refused = await as.admin.del(`/v1/users/${member.id}`);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'super_admin_only');
    const res = await as.superAdmin2.del(`/v1/users/${member.id}`);
    assert.equal(res.status, 204);
    assert.ok(!(await as.admin.get('/v1/users')).body.some((m: any) => m.id === member.id));
    assert.equal((await h.sql(`select 1 from users where id = $1`, [member.userId])).length, 1);
    const [audit] = await h.sql(`select * from audit_log where action = 'users.remove' and entity_id = $1`, [String(member.id)]);
    assert.equal(audit.before.role, 'worker');
    assert.equal(audit.destructive, true);
  });

  it('removes a member the audit log names as an actor, keeping their audit rows', async () => {
    const { member, client } = await newMember('admin');
    assert.equal((await add(client, 'worker')).status, 200); // audited, with them as the actor
    const res = await as.superAdmin2.del(`/v1/users/${member.id}`);
    assert.equal(res.status, 204);
    assert.equal((await h.sql(`select 1 from property_members where id = $1`, [member.id])).length, 0);
    const trail = await h.sql(`select actor_member_id from audit_log where actor_user_id = $1`, [member.userId]);
    assert.ok(trail.length >= 1);
    assert.ok(trail.every((r: any) => r.actor_member_id === null));
    assert.equal((await client.get('/v1/machines')).status, 401);
  });

  it('cannot reach another property\'s members', async () => {
    const other = await seedProperty(h);
    const id = other.members.worker.memberId;
    assert.equal((await as.superAdmin.patch(`/v1/users/${id}/access`, { modules: { production: 'view' } })).status, 404);
    assert.equal((await as.superAdmin.post(`/v1/users/${id}/disable`)).status, 404);
    assert.equal((await as.superAdmin.post(`/v1/users/${id}/super-admin`)).status, 404);
    assert.ok(!(await as.superAdmin.get('/v1/users')).body.some((m: any) => m.id === id));
  });
});

describe('the owner\'s own', () => {
  it('makes and removes super admins; nobody else may', async () => {
    const { member } = await newMember('admin');
    const refused = await as.superAdmin2.post(`/v1/users/${member.id}/super-admin`);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'owner_only');

    await h.sql(`insert into member_module_access (member_id, module, level) values ($1, 'production', 'view')`, [member.id]);
    const made = await as.superAdmin.post(`/v1/users/${member.id}/super-admin`);
    assert.equal(made.status, 200);
    assert.equal(made.body.role, 'superAdmin');
    assert.ok(made.body.modules.every((x: any) => x.level === 'edit'));
    const [audit] = await h.sql(`select * from audit_log where action = 'users.manage_super_admins'`);
    assert.equal(audit.before.role, 'admin');
    assert.equal(audit.after.role, 'superAdmin');

    const back = await as.superAdmin.del(`/v1/users/${member.id}/super-admin`);
    assert.equal(back.body.role, 'admin');
    const owner = await as.superAdmin.del(`/v1/users/${p.members.superAdmin.memberId}/super-admin`);
    assert.equal(owner.status, 403);
    // Removing super admin from someone who is not one promotes nobody.
    const worker = await as.superAdmin.del(`/v1/users/${p.members.worker.memberId}/super-admin`);
    assert.equal(worker.body.role, 'worker');
  });

  it('hands the unit to a super admin only, and only from the owner', async () => {
    const refused = await as.superAdmin2.post('/v1/users/transfer-ownership', { toMemberId: p.members.superAdmin2.memberId });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'owner_only');
    const notSuper = await as.superAdmin.post('/v1/users/transfer-ownership', { toMemberId: p.members.admin.memberId });
    assert.equal(notSuper.status, 400);
    assert.equal(notSuper.body.error.details.fields.toMemberId, 'notSuperAdmin');

    const res = await as.superAdmin.post('/v1/users/transfer-ownership', { toMemberId: p.members.superAdmin2.memberId });
    assert.equal(res.status, 204);
    const owners = await h.sql(`select id from property_members where property_id = $1 and is_owner`, [p.propertyId]);
    assert.deepEqual(owners, [{ id: p.members.superAdmin2.memberId }]);
    // The new owner acts as owner at once; the old one no longer can.
    assert.equal((await as.superAdmin.post('/v1/users/transfer-ownership',
      { toMemberId: p.members.superAdmin.memberId })).body.error.code, 'owner_only');
    assert.equal((await as.superAdmin2.post('/v1/users/transfer-ownership',
      { toMemberId: p.members.superAdmin.memberId })).status, 204);
    const [audit] = await h.sql(`select * from audit_log where action = 'users.transfer_ownership' order by id limit 1`);
    assert.deepEqual(audit.after, { ownerMemberId: p.members.superAdmin2.memberId });
  });
});
