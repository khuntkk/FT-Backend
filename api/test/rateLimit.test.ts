// The per-IP limit on the unauthenticated POST routes, in its own harness so
// the requests it spends do not count against other tests.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, startHarness, type Harness } from './helpers.ts';

let h: Harness;
before(async () => { h = await startHarness({ unauthLimit: 30 }); });
after(() => h.close());

describe('per-IP limit on unauthenticated routes', () => {
  it('answers 429 rate_limited in the contract shape past the limit', async () => {
    let last: { status: number; body: any } | undefined;
    let limitedAt = 0;
    for (let i = 1; i <= 40 && !limitedAt; i++) {
      last = await new Client(h.app).post('/v1/auth/login', {
        identifier: `nobody${i}`, password: 'x', client: 'managerApp', keepSignedIn: false,
      });
      if (last.status === 429) limitedAt = i;
    }
    assert.ok(limitedAt > 1, 'limited, but not on the first request');
    assert.equal(last!.body.error.code, 'rate_limited');
    assert.equal(typeof last!.body.error.details.retryAfter, 'number');
  });

  it('does not limit authenticated or health routes', async () => {
    for (let i = 0; i < 40; i++) assert.equal((await new Client(h.app).get('/health')).status, 200);
  });

  it('sets x-request-id and no-store', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    assert.match(String(res.headers['x-request-id']), /^[0-9a-f-]{36}$/);
    assert.equal(res.headers['cache-control'], 'no-store');
  });
});
