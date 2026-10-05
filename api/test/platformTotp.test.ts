import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hashPassword } from '../src/auth/passwords.ts';
import { codeAt, stepAt } from '../src/auth/totp.ts';
import { Client, PASSWORD, startHarness, type Harness } from './helpers.ts';

let h: Harness;

before(async () => {
  h = await startHarness();
});
after(() => h.close());

async function makeStaff(email: string, role: 'admin' | 'support'): Promise<number> {
  const [{ id }] = await h.sql(
    `insert into users (display_name, email, password_hash, must_change_password)
     values ($1, $2, $3, false) returning id`, [email, email, await hashPassword(PASSWORD)]);
  await h.sql(`insert into platform_staff (user_id, role) values ($1, $2)`, [id, role]);
  return id;
}

const login = (email: string, totpCode?: string) =>
  new Client(h.app).post('/v1/platform/auth/login', { email, password: PASSWORD, ...(totpCode && { totpCode }) });

async function signedIn(email: string, totpCode?: string): Promise<Client> {
  const res = await login(email, totpCode);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return new Client(h.app, res.body.accessToken);
}

/** The code for the step after the last one used, so a test never replays one. */
const codeFor = (secret: string, offset = 0) => codeAt(secret, stepAt() + offset);

describe('two-factor sign-in for console staff', () => {
  let secret: string;

  it('is off until set up and enabled with a matching code', async () => {
    await makeStaff('ana@stitchflow.test', 'admin');
    const ana = await signedIn('ana@stitchflow.test');
    const setup = await ana.post('/v1/platform/auth/totp/setup');
    assert.equal(setup.status, 200);
    secret = setup.body.secret;
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\/StitchFlow%3Aana%40stitchflow\.test\?secret=/);
    // Set up but not enabled: the password alone still signs in.
    assert.equal((await login('ana@stitchflow.test')).status, 200);

    const wrong = await ana.post('/v1/platform/auth/totp/enable', { code: '000000' === codeFor(secret) ? '111111' : '000000' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.details.fields.code, 'wrongTotp');
    assert.equal((await ana.post('/v1/platform/auth/totp/enable', { code: codeFor(secret, -1) })).status, 204);
    const list = await ana.get('/v1/platform/staff');
    assert.equal(list.body.find((s: any) => s.email === 'ana@stitchflow.test').totpEnabled, true);
  });

  it('then asks for a code at sign-in, and takes each code once', async () => {
    const without = await login('ana@stitchflow.test');
    assert.equal(without.status, 401);
    assert.equal(without.body.error.details.reason, 'totpRequired');
    const code = codeFor(secret);
    assert.equal((await login('ana@stitchflow.test', code)).status, 200);
    const replay = await login('ana@stitchflow.test', code);
    assert.equal(replay.body.error.details.reason, 'wrongTotp');
  });

  it('never writes the secret into the audit log', async () => {
    const rows = await h.sql(`select coalesce(before::text, '') || coalesce(after::text, '') as body from audit_log`);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r: any) => !r.body.includes(secret)));
  });

  it('is turned off with a current code, or by another admin after a lost phone', async () => {
    const ana = await signedIn('ana@stitchflow.test', codeFor(secret, 1));
    const self = await ana.del(`/v1/platform/staff/${(await h.sql(`select id from users where email = 'ana@stitchflow.test'`))[0].id}/totp`);
    assert.equal(self.body.error.details.fields.id, 'self');

    const bo = await makeStaff('bo@stitchflow.test', 'admin');
    const boClient = await signedIn('bo@stitchflow.test');
    const s = (await boClient.post('/v1/platform/auth/totp/setup')).body.secret;
    await boClient.post('/v1/platform/auth/totp/enable', { code: codeFor(s) });
    assert.equal((await login('bo@stitchflow.test')).status, 401);
    assert.equal((await ana.del(`/v1/platform/staff/${bo}/totp`)).status, 204);
    assert.equal((await login('bo@stitchflow.test')).status, 200);
  });

  it('cannot be reset by support staff', async () => {
    const sam = await makeStaff('sam@stitchflow.test', 'support');
    const samClient = await signedIn('sam@stitchflow.test');
    const res = await samClient.del(`/v1/platform/staff/${sam}/totp`);
    assert.equal(res.status, 403);
  });
});
