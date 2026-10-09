import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hashToken } from '../src/auth/tokens.ts';
import { normalizeIp } from '../src/services/rateLimit.ts';
import { Client, PASSWORD, seedProperty, signIn, startHarness, type Harness, type SeededProperty } from './helpers.ts';

let h: Harness;
let p: SeededProperty;

before(async () => {
  h = await startHarness();
  p = await seedProperty(h);
});
after(() => h.close());

describe('sign-in', () => {
  it('signs in with a username and picks the only property', async () => {
    const c = new Client(h.app);
    const res = await c.post('/v1/auth/login', {
      identifier: p.members.admin.username, password: PASSWORD, client: 'managerApp', keepSignedIn: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.expiresIn, 900);
    assert.equal(res.body.activeMember.memberId, p.members.admin.memberId);
    assert.equal(res.body.user.username, p.members.admin.username);
    assert.equal(res.body.user.passwordHash, undefined);
    const [s] = await h.sql(`select extract(day from expires_at - created_at)::int as days, keep_signed_in from auth_sessions
                             where user_id = $1`, [p.members.admin.userId]);
    assert.equal(s.keep_signed_in, true);
    assert.equal(s.days, 15);
  });

  it('fails the same way for a wrong password and an unknown user', async () => {
    const c = new Client(h.app);
    const wrong = await c.post('/v1/auth/login', {
      identifier: p.members.admin.username, password: 'nope-nope', client: 'managerApp', keepSignedIn: false,
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'unauthenticated');
    assert.equal(wrong.body.error.details.reason, 'wrongPassword');
    const none = await c.post('/v1/auth/login', {
      identifier: 'nobody-here', password: 'x', client: 'managerApp', keepSignedIn: false,
    });
    assert.equal(none.status, 401);
    assert.equal(none.body.error.details.reason, 'wrongPassword');
    assert.equal(none.body.error.message, wrong.body.error.message);
    assert.equal(none.body.error.message, 'Phone, email or password is not right.');
  });

  it('refuses over-long identifiers and passwords with the generic 401', async () => {
    const c = new Client(h.app);
    const long = await c.post('/v1/auth/login', {
      identifier: 'a'.repeat(300), password: 'x', client: 'managerApp', keepSignedIn: false,
    });
    assert.equal(long.status, 401);
    assert.equal(long.body.error.details.reason, 'wrongPassword');
    const pw = await c.post('/v1/auth/login', {
      identifier: p.members.admin.username, password: 'x'.repeat(300), client: 'managerApp', keepSignedIn: false,
    });
    assert.equal(pw.status, 401);
  });

  it('rate-limits repeated failures for one identifier from one address', async () => {
    const c = new Client(h.app);
    const body = { identifier: 'ghost', password: 'x', client: 'managerApp', keepSignedIn: false };
    for (let i = 0; i < 10; i++) assert.equal((await c.post('/v1/auth/login', body)).status, 401);
    const res = await c.post('/v1/auth/login', body);
    assert.equal(res.status, 429);
    assert.equal(res.body.error.code, 'rate_limited');
  });

  it('does not lock a user out from another address, and a success resets the count', async () => {
    const attempt = (ip: string, password: string) => h.app.inject({
      method: 'POST', url: '/v1/auth/login', remoteAddress: ip,
      payload: { identifier: p.members.worker.username, password, client: 'managerApp', keepSignedIn: false },
    });
    for (let i = 0; i < 10; i++) assert.equal((await attempt('10.0.0.1', 'wrong-wrong')).statusCode, 401);
    assert.equal((await attempt('10.0.0.1', PASSWORD)).statusCode, 429);
    assert.equal((await attempt('10.0.0.2', PASSWORD)).statusCode, 200);
    // Nine failures, a success, nine more: never refused.
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 9; i++) assert.equal((await attempt('10.0.0.3', 'wrong-wrong')).statusCode, 401);
      assert.equal((await attempt('10.0.0.3', PASSWORD)).statusCode, 200);
    }
  });

  it('counts a whole IPv6 /64 as one address', () => {
    assert.equal(normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), normalizeIp('2001:db8:1:2::1'));
    assert.notEqual(normalizeIp('2001:db8:1:2::1'), normalizeIp('2001:db8:1:3::1'));
    assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
  });

  it('validates the body against the contract', async () => {
    const res = await new Client(h.app).post('/v1/auth/login', { identifier: 'x' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.ok(Object.keys(res.body.error.details.fields).some((f) => f.includes('password')));
  });
});

describe('tokens', () => {
  it('refuses requests without a valid token', async () => {
    const res = await new Client(h.app, 'garbage').get('/v1/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'unauthenticated');
  });

  it('rotates the refresh token and revokes the family when an old one is replayed', async () => {
    const c = await signIn(h, p.members.worker.username);
    const first = c.refreshToken!;
    const r1 = await c.post('/v1/auth/refresh', { refreshToken: first });
    assert.equal(r1.status, 200);
    assert.notEqual(r1.body.refreshToken, first);
    // The rotated-away token, used again after the grace window: copied, so everything in the family ends.
    await h.sql(`update auth_sessions set revoked_at = now() - interval '2 minutes' where refresh_token_hash = $1`,
      [hashToken(first)]);
    const replay = await c.post('/v1/auth/refresh', { refreshToken: first });
    assert.equal(replay.status, 401);
    const r2 = await c.post('/v1/auth/refresh', { refreshToken: r1.body.refreshToken });
    assert.equal(r2.status, 401);
  });

  it('treats a retried refresh within the grace window as the same refresh', async () => {
    const c = await signIn(h, p.members.supervisor.username);
    const first = c.refreshToken!;
    const r1 = await c.post('/v1/auth/refresh', { refreshToken: first });
    assert.equal(r1.status, 200);
    // The reply was lost: the client retries with the token it still has.
    const r2 = await c.post('/v1/auth/refresh', { refreshToken: first });
    assert.equal(r2.status, 200);
    assert.notEqual(r2.body.refreshToken, r1.body.refreshToken);
    // The retried pair works; the superseded one never reached a client.
    assert.equal((await c.post('/v1/auth/refresh', { refreshToken: r2.body.refreshToken })).status, 200);
  });

  it('ends the family when the pair a retried refresh superseded is presented', async () => {
    const c = await signIn(h, p.members.supervisor.username);
    const first = c.refreshToken!;
    const r1 = await c.post('/v1/auth/refresh', { refreshToken: first });
    const r2 = await c.post('/v1/auth/refresh', { refreshToken: first });
    assert.equal(r2.status, 200);
    // Nobody legitimate holds r1's token any more: whoever presents it copied it.
    assert.equal((await c.post('/v1/auth/refresh', { refreshToken: r1.body.refreshToken })).status, 401);
    assert.equal((await c.post('/v1/auth/refresh', { refreshToken: r2.body.refreshToken })).status, 401);
  });

  it('revokes the family when a rotated token is replayed after the grace window', async () => {
    const c = await signIn(h, p.members.admin.username);
    const first = c.refreshToken!;
    const r1 = await c.post('/v1/auth/refresh', { refreshToken: first });
    assert.equal(r1.status, 200);
    await h.sql(`update auth_sessions set revoked_at = now() - interval '2 minutes' where refresh_token_hash = $1`,
      [hashToken(first)]);
    assert.equal((await c.post('/v1/auth/refresh', { refreshToken: first })).status, 401);
    assert.equal((await c.post('/v1/auth/refresh', { refreshToken: r1.body.refreshToken })).status, 401);
  });

  it('logs out a session', async () => {
    const c = await signIn(h, p.members.viewAdmin.username);
    assert.equal((await c.post('/v1/auth/logout', { refreshToken: c.refreshToken })).status, 204);
    assert.equal((await c.post('/v1/auth/refresh', { refreshToken: c.refreshToken })).status, 401);
  });
});

describe('/me', () => {
  it('returns the member, property, settings and module levels', async () => {
    const c = await signIn(h, p.members.supervisor.username);
    const res = await c.get('/v1/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.member.role, 'supervisor');
    assert.equal(res.body.property.id, p.propertyId);
    assert.equal(res.body.settings.timezone, 'Asia/Kolkata');
    const levels = Object.fromEntries(res.body.modules.map((m: any) => [m.module, m.level]));
    assert.equal(levels.payroll, 'none');
    assert.equal(levels.production, 'edit');
    assert.equal(levels.machines, 'view');
  });
});

describe('temporary passwords', () => {
  it('blocks everything but /me and /auth until the password is changed', async () => {
    const [{ id: userId }] = await h.sql(
      `insert into users (display_name, username, password_hash, must_change_password)
       select 'Temp', 'temp-user', password_hash, true from users where id = $1 returning id`,
      [p.members.admin.userId]);
    await h.sql(`insert into property_members (property_id, user_id, role) values ($1, $2, 'admin')`,
      [p.propertyId, userId]);
    const c = await signIn(h, 'temp-user');
    assert.equal((await c.get('/v1/me')).status, 200);
    const blocked = await c.get('/v1/machines');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'password_change_required');

    const demo = await c.post('/v1/auth/change-password', { current: PASSWORD, next: 'Admin@936!' });
    assert.equal(demo.body.error.details.reason, 'demoPassword');
    const short = await c.post('/v1/auth/change-password', { current: PASSWORD, next: 'short' });
    assert.equal(short.body.error.details.reason, 'tooShort');
    assert.equal((await c.post('/v1/auth/change-password', { current: PASSWORD, next: 'a-much-better-one' })).status, 204);
    assert.equal((await c.get('/v1/machines')).status, 200);
  });
});

describe('several properties', () => {
  it('asks the user to choose, then binds the token to the chosen one', async () => {
    const other = await seedProperty(h);
    await h.sql(`insert into property_members (property_id, user_id, role) values ($1, $2, 'viewAdmin')`,
      [other.propertyId, p.members.admin.userId]);
    const c = new Client(h.app);
    const login = await c.post('/v1/auth/login', {
      identifier: p.members.admin.username, password: PASSWORD, client: 'managerApp', keepSignedIn: false,
    });
    assert.equal(login.body.memberships.length, 2);
    assert.equal(login.body.activeMember, null);
    c.token = login.body.accessToken;
    const before = await c.get('/v1/machines');
    assert.equal(before.status, 403);
    assert.equal(before.body.error.details.reason, 'noPropertySelected');

    const target = login.body.memberships.find((m: any) => m.propertyId === other.propertyId);
    const pick = await c.post('/v1/auth/select-property', { memberId: target.memberId });
    assert.equal(pick.status, 200);
    c.token = pick.body.accessToken;
    const me = await c.get('/v1/me');
    assert.equal(me.body.property.id, other.propertyId);
    assert.equal(me.body.member.role, 'viewAdmin');
  });
});

describe('sessions end at the access token too', () => {
  it('logout kills the old access token; a refresh hands over a working one', async () => {
    const q = await seedProperty(h);
    const c = await signIn(h, q.members.admin.username);
    assert.equal((await c.get('/v1/machines')).status, 200);

    const oldToken = c.token!;
    const r = await c.post('/v1/auth/refresh', { refreshToken: c.refreshToken });
    assert.equal(r.status, 200);
    const rotated = new Client(h.app, r.body.accessToken);
    assert.equal((await rotated.get('/v1/machines')).status, 200);
    // The old token's own session was rotated away, but its family lives on.
    assert.equal((await new Client(h.app, oldToken).get('/v1/machines')).status, 200);

    assert.equal((await rotated.post('/v1/auth/logout', { refreshToken: r.body.refreshToken })).status, 204);
    assert.equal((await rotated.get('/v1/machines')).status, 401);
    assert.equal((await new Client(h.app, oldToken).get('/v1/machines')).status, 401);
    assert.equal((await rotated.get('/v1/me')).status, 401);
  });

  it('sign out everywhere ends other devices\' access tokens', async () => {
    const q = await seedProperty(h);
    const one = await signIn(h, q.members.admin.username);
    const two = await signIn(h, q.members.admin.username);
    assert.equal((await one.post('/v1/auth/logout?everywhere=true', { refreshToken: one.refreshToken })).status, 204);
    assert.equal((await two.get('/v1/machines')).status, 401);
  });

  it('refuses a token whose claims are the wrong shape', async () => {
    const { signAccessToken } = await import('../src/auth/tokens.ts');
    const bad = signAccessToken({ sub: 1.5, sid: 'nope', client: 'managerApp', mid: null, pid: null, role: null },
      'test-secret-test-secret-test-secret!');
    assert.equal((await new Client(h.app, bad).get('/v1/machines')).status, 401);
  });

  it('changing the password ends every other session but not the caller\'s', async () => {
    const q = await seedProperty(h);
    const mine = await signIn(h, q.members.admin.username);
    const other = await signIn(h, q.members.admin.username);
    assert.equal((await mine.post('/v1/auth/change-password', { current: PASSWORD, next: 'a-much-better-one' })).status, 204);
    const stolen = await other.post('/v1/auth/refresh', { refreshToken: other.refreshToken });
    assert.equal(stolen.status, 401);
    assert.equal((await other.get('/v1/machines')).status, 401);
    const own = await mine.post('/v1/auth/refresh', { refreshToken: mine.refreshToken });
    assert.equal(own.status, 200);
    assert.equal((await new Client(h.app, own.body.accessToken).get('/v1/machines')).status, 200);
  });
});
