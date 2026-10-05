// Photos in Supabase Storage, against a stand-in for its REST API that
// answers the calls storage.ts makes the way Supabase does.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';
import { ensureSupabaseBucket, supabaseStorage } from '../src/storage/storage.ts';
import { seedProperty, signInAll, startHarness, type Client, type Harness } from './helpers.ts';

const KEY = 'sb_secret_test';
const objects = new Map<string, { bytes: Buffer; type: string }>();
const buckets = new Set<string>();
let server: Server;
let url: string;

function fakeSupabase(): Server {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const u = new URL(req.url!, 'http://x');
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    };
    const signed = /^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/.exec(u.pathname);
    // A signed link carries its own token and no key.
    if (req.method === 'GET' && signed) {
      const o = objects.get(`${signed[1]}/${decodeURIComponent(signed[2])}`);
      if (u.searchParams.get('token') !== 'tok' || !o) return send(400, { error: 'InvalidSignature' });
      return res.writeHead(200, { 'content-type': o.type }).end(o.bytes);
    }
    if (req.headers.apikey !== KEY || req.headers.authorization !== `Bearer ${KEY}`) {
      return send(403, { error: 'Unauthorized' });
    }
    const bucket = /^\/storage\/v1\/bucket\/([^/]+)$/.exec(u.pathname);
    if (req.method === 'GET' && bucket) {
      return buckets.has(bucket[1]) ? send(200, { id: bucket[1] }) : send(400, { statusCode: '404', error: 'Bucket not found' });
    }
    if (req.method === 'POST' && u.pathname === '/storage/v1/bucket') {
      const b = JSON.parse(body.toString());
      assert.equal(b.public, false);
      buckets.add(b.id);
      return send(200, { name: b.id });
    }
    if (req.method === 'POST' && signed) {
      return send(200, { signedURL: `/object/sign/${signed[1]}/${signed[2]}?token=tok` });
    }
    const object = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (req.method === 'POST' && object) {
      objects.set(`${object[1]}/${decodeURIComponent(object[2])}`, { bytes: body, type: String(req.headers['content-type']) });
      return send(200, { Key: `${object[1]}/${object[2]}` });
    }
    const removeIn = /^\/storage\/v1\/object\/([^/]+)$/.exec(u.pathname);
    if (req.method === 'DELETE' && removeIn) {
      for (const k of JSON.parse(body.toString()).prefixes) objects.delete(`${removeIn[1]}/${k}`);
      return send(200, []);
    }
    send(404, { error: 'not found' });
  });
}

function png(): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, 'ascii');
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); t.copy(out, 4); data.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([t, data])), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(14))), chunk('IEND', Buffer.alloc(0))]);
}

let h: Harness;
let admin: Client;
const config = () => ({ url, secretKey: KEY, bucket: 'stitchflow-photos' });

before(async () => {
  server = fakeSupabase();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  h = await startHarness({ storage: supabaseStorage(config()) });
  admin = (await signInAll(h, await seedProperty(h))).admin;
});
after(async () => {
  await h.close();
  server.close();
});

describe('Supabase Storage', () => {
  it('creates the private bucket once', async () => {
    assert.equal(await ensureSupabaseBucket(config()), 'created');
    assert.equal(await ensureSupabaseBucket(config()), 'exists');
  });

  it('uploads a photo to the bucket and hands out Supabase signed URLs', async () => {
    const boundary = '----sf';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nmachinePhoto\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="m.png"\r\n\r\n`),
      png(), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await admin.call('POST', '/v1/files', {
      body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.url.startsWith(`${url}/storage/v1/object/sign/stitchflow-photos/`));
    const [stored] = [...objects.entries()];
    assert.match(stored[0], /^stitchflow-photos\/\d+\/[0-9a-f-]+\.png$/);
    assert.equal(stored[1].type, 'image/png');
    assert.deepEqual(stored[1].bytes, png());

    const redirect = await admin.get(`/v1/files/${res.body.id}`);
    assert.equal(redirect.status, 302);
    const fetched = await fetch(String(redirect.headers.location));
    assert.equal(fetched.status, 200);
    assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), png());
  });

  it('removes an object', async () => {
    const [key] = [...objects.keys()];
    await supabaseStorage(config()).remove(key.slice('stitchflow-photos/'.length));
    assert.equal(objects.size, 0);
  });

  it('says what Supabase refused', async () => {
    const wrong = supabaseStorage({ ...config(), secretKey: 'nope' });
    await assert.rejects(wrong.put('1/x.png', png(), 'image/png'), /Supabase Storage POST .* 403/);
  });

  it('serves no local raw links when photos are in Supabase', async () => {
    assert.equal((await h.app.inject({ method: 'GET', url: '/files/raw/1/x.png?exp=1&sig=x' })).statusCode, 404);
  });
});
