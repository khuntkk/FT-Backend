import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';
import { Client, seedProperty, signInAll, startHarness, type Harness, type SeededProperty } from './helpers.ts';
import { sniffImage } from '../src/services/files.ts';

let h: Harness;
let p: SeededProperty;
let as: Record<string, Client>;

before(async () => {
  h = await startHarness();
  p = await seedProperty(h);
  as = await signInAll(h, p);
});
after(() => h.close());

/** A real 3×2 PNG. */
function png(width = 3, height = 2): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, 'ascii');
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    t.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([t, data])), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function multipart(fields: Record<string, string>, file?: Buffer) {
  const boundary = '----sf' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`), file, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const upload = (c: Client, fields: Record<string, string>, file?: Buffer) => {
  const m = multipart(fields, file);
  return c.call('POST', '/v1/files', { body: m.body, headers: m.headers });
};

describe('files', () => {
  it('reads type and size from the bytes', () => {
    assert.deepEqual(sniffImage(png(3, 2)), { contentType: 'image/png', ext: 'png', width: 3, height: 2 });
    assert.equal(sniffImage(Buffer.from('not an image at all')), null);
  });

  it('uploads a machine photo and serves it through a short-lived signed URL', async () => {
    const res = await upload(as.admin, { purpose: 'machinePhoto' }, png());
    assert.equal(res.status, 200);
    assert.equal(res.body.purpose, 'machinePhoto');
    assert.equal(res.body.width, 3);
    assert.match(res.body.url, /^http:\/\/.+\/files\/raw\/\d+\/[0-9a-f-]+\.png\?exp=\d+&sig=/);

    const redirect = await as.worker.get(`/v1/files/${res.body.id}`);
    assert.equal(redirect.status, 302);
    const signed = new URL(String(redirect.headers.location));
    const raw = await h.app.inject({ method: 'GET', url: signed.pathname + signed.search });
    assert.equal(raw.statusCode, 200);
    assert.equal(raw.headers['content-type'], 'image/png');
    assert.deepEqual(raw.rawPayload, png());

    const tampered = await h.app.inject({ method: 'GET', url: signed.pathname + signed.search.replace(/sig=(.)/, (_m, c) => `sig=${c === 'x' ? 'y' : 'x'}`) });
    assert.equal(tampered.statusCode, 403);
  });

  it('checks the action of what the file is for', async () => {
    const res = await upload(as.supervisor, { purpose: 'staffPhoto' }, png());
    assert.equal(res.status, 403);
    assert.equal(res.body.error.details.action, 'staff.update');
    assert.equal((await upload(as.supervisor, { purpose: 'slipPhoto' }, png())).status, 200);
  });

  it('refuses what is not an image, and a missing purpose', async () => {
    const notImage = await upload(as.admin, { purpose: 'machinePhoto' }, Buffer.from('hello'));
    assert.equal(notImage.body.error.code, 'validation_failed');
    const noPurpose = await upload(as.admin, {}, png());
    assert.equal(noPurpose.body.error.details.fields.purpose, 'required');
  });

  it('does not serve another property\'s file', async () => {
    const other = await seedProperty(h);
    const theirs = await upload((await signInAll(h, other)).admin, { purpose: 'machinePhoto' }, png());
    assert.equal((await as.admin.get(`/v1/files/${theirs.body.id}`)).status, 404);
  });
});

describe('live updates', () => {
  it('tells listeners in the property which rows changed, after commit only', async () => {
    const heard: unknown[] = [];
    const stop = h.events.listen(p.propertyId, { memberId: 0, tables: new Set(['machines']) }, (n) => heard.push(n));
    const res = await as.admin.post('/v1/machines', { number: 41 });
    assert.deepEqual(heard, [{ table: 'machines', ids: [res.body.id] }]);
    // Refused (taken number): rolled back, so nobody hears of it.
    await as.admin.post('/v1/machines', { number: 41 });
    assert.equal(heard.length, 1);
    stop();
  });

  it('streams change notices to GET /v1/events', async () => {
    const address = await h.app.listen({ port: 0, host: '127.0.0.1' });
    const ac = new AbortController();
    const res = await fetch(`${address}/v1/events`, {
      headers: { authorization: `Bearer ${as.worker.token}` }, signal: ac.signal,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body!.getReader();
    await reader.read(); // ": connected"
    const made = await as.admin.post('/v1/machines', { number: 42 });
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), new RegExp(`event: change\\ndata: \\{"table":"machines","ids":\\[${made.body.id}\\]\\}`));
    ac.abort();
  });

  it('sends a worker only the tables they may view, and ends a disabled member\'s stream', async () => {
    const address = `http://127.0.0.1:${(h.app.server.address() as any).port}`;
    const ac = new AbortController();
    const res = await fetch(`${address}/v1/events`, {
      headers: { authorization: `Bearer ${as.worker.token}` }, signal: ac.signal,
    });
    const reader = res.body!.getReader();
    await reader.read(); // ": connected"
    const [{ id: staffId }] = await h.sql(
      `insert into staff (property_id, name, category) values ($1, 'Evt', 'karigar') returning id`, [p.propertyId]);
    assert.equal((await as.admin.post('/v1/advances', { staffId, givenOn: '2026-09-01', amount: 10, mode: 'cash' })).status, 200);
    const made = await as.admin.post('/v1/machines', { number: 43 });
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.doesNotMatch(text, /advances/);
    assert.match(text, new RegExp(`"table":"machines","ids":\\[${made.body.id}\\]`));

    const off = await as.admin.post(`/v1/users/${p.members.worker.memberId}/disable`);
    assert.equal(off.status, 200);
    let ended = '';
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      ended += new TextDecoder().decode(r.value);
    }
    assert.match(ended, /event: bye/);
    ac.abort();
  });
});

describe('CORS', () => {
  it('answers the web admin panel\'s origin, and only it', async () => {
    const hc = await startHarness({ corsOrigins: ['https://admin.example.com'] });
    const pre = await hc.app.inject({ method: 'OPTIONS', url: '/v1/platform/properties',
      headers: { origin: 'https://admin.example.com', 'access-control-request-method': 'GET' } });
    assert.equal(pre.statusCode, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'https://admin.example.com');
    assert.match(String(pre.headers['access-control-allow-headers']), /authorization/);
    const other = await hc.app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } });
    assert.equal(other.headers['access-control-allow-origin'], undefined);
    await hc.close();
  });
});
