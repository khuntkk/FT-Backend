import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiRequestError, createClient } from '../dist/index.js';

const fakeFetch = (handler) => async (url, init) => handler(new URL(url), init);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('builds the path, query and bearer header', async () => {
  let seen;
  const api = createClient({
    baseUrl: 'https://api.test/',
    getAccessToken: () => 'tok',
    fetch: fakeFetch((url, init) => { seen = { url, init }; return json(200, []); }),
  });
  await api.call('GET /v1/production/day', { query: { date: '2026-09-27', shiftId: 4 } });
  assert.equal(seen.url.pathname, '/v1/production/day');
  assert.equal(seen.url.searchParams.get('date'), '2026-09-27');
  assert.equal(seen.init.headers.authorization, 'Bearer tok');
});

test('sign-in sends no token', async () => {
  let headers;
  const api = createClient({
    baseUrl: 'https://api.test', getAccessToken: () => 'tok',
    fetch: fakeFetch((_, init) => { headers = init.headers; return json(200, {}); }),
  });
  await api.call('POST /v1/auth/login', { body: { identifier: 'kaushik', password: 'x', client: 'managerApp', keepSignedIn: false } });
  assert.equal(headers.authorization, undefined);
});

test('fills path parameters and returns nothing for 204', async () => {
  let path;
  const api = createClient({ baseUrl: 'https://api.test', fetch: fakeFetch((url) => { path = url.pathname; return new Response(null, { status: 204 }); }) });
  const out = await api.call('POST /v1/recycle-bin/:kind/:id/restore', { params: { kind: 'machine', id: 3 } });
  assert.equal(path, '/v1/recycle-bin/machine/3/restore');
  assert.equal(out, undefined);
});

test("an error carries the contract's code and details", async () => {
  const api = createClient({
    baseUrl: 'https://api.test',
    fetch: fakeFetch(() => json(409, { error: { code: 'machine_number_taken', message: 'Machine 3 already exists.', details: { number: 3 } } })),
  });
  await assert.rejects(api.call('POST /v1/machines', { body: { number: 3 } }), (e) => {
    assert.ok(e instanceof ApiRequestError);
    assert.equal(e.status, 409);
    assert.equal(e.code, 'machine_number_taken');
    assert.equal(e.details.number, 3);
    return true;
  });
});

test('refreshes once on token_expired, then retries', async () => {
  let calls = 0;
  let token = 'old';
  const api = createClient({
    baseUrl: 'https://api.test',
    getAccessToken: () => token,
    onTokenExpired: async () => { token = 'new'; return true; },
    fetch: fakeFetch((_, init) => {
      calls++;
      return init.headers.authorization === 'Bearer new' ? json(200, { ok: true }) : json(401, { error: { code: 'token_expired', message: 'expired' } });
    }),
  });
  const me = await api.call('GET /v1/me');
  assert.deepEqual(me, { ok: true });
  assert.equal(calls, 2);
});
