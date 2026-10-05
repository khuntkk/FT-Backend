// Where photo bytes live: Supabase Storage (a private bucket, read through
// short-lived signed URLs), or local disk when no Supabase project is set.
//
// Supabase is spoken to over its Storage REST API with Node's own fetch, so
// no SDK. Local disk serves its own signed links: the API's
// /files/raw/<key>?exp=&sig=, an HMAC of the key and expiry.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const SIGNED_URL_SECONDS = 10 * 60;

export interface Storage {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** A URL that serves the file for a few minutes. `origin` is the API's own, as the client reached it. */
  signedUrl(key: string, origin: string): Promise<string>;
  /** Only for local disk, whose links the API serves itself. */
  local?: {
    get(key: string): Promise<Buffer | null>;
    verify(key: string, exp: string, sig: string, now?: number): boolean;
  };
}

export function localStorage(dir: string, secret: string): Storage {
  const root = resolve(dir);
  const pathOf = (key: string) => {
    const p = resolve(join(root, key));
    if (!p.startsWith(root + '/')) throw new Error('bad storage key');
    return p;
  };
  const sign = (key: string, exp: number) =>
    createHmac('sha256', secret).update(`file:${key}:${exp}`).digest('base64url');
  return {
    async put(key, bytes) {
      const p = pathOf(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, bytes);
    },
    async remove(key) {
      await rm(pathOf(key), { force: true });
    },
    async signedUrl(key, origin) {
      const exp = Math.floor(Date.now() / 1000) + SIGNED_URL_SECONDS;
      return `${origin}/files/raw/${key}?exp=${exp}&sig=${sign(key, exp)}`;
    },
    local: {
      async get(key) {
        try {
          return await readFile(pathOf(key));
        } catch {
          return null;
        }
      },
      verify(key, exp, sig, now = Date.now()) {
        const e = Number(exp);
        if (!Number.isInteger(e) || e * 1000 < now) return false;
        const want = Buffer.from(sign(key, e));
        const got = Buffer.from(sig ?? '');
        return want.length === got.length && timingSafeEqual(want, got);
      },
    },
  };
}

export interface SupabaseStorageConfig {
  /** https://<project-ref>.supabase.co */
  url: string;
  /** The project's secret (service role) key: it can read any private bucket. */
  secretKey: string;
  bucket: string;
}

export function supabaseStorage({ url, secretKey, bucket }: SupabaseStorageConfig): Storage {
  const base = `${url.replace(/\/+$/, '')}/storage/v1`;
  const objectPath = (key: string) => `${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const call = (method: string, path: string, body?: string | Uint8Array, headers: Record<string, string> = {}) =>
    supabaseCall(base, secretKey, method, path, body, headers);
  return {
    async put(key, bytes, contentType) {
      await call('POST', `/object/${objectPath(key)}`, new Uint8Array(bytes), { 'content-type': contentType });
    },
    async remove(key) {
      await call('DELETE', `/object/${encodeURIComponent(bucket)}`, JSON.stringify({ prefixes: [key] }),
        { 'content-type': 'application/json' });
    },
    async signedUrl(key) {
      const res = await call('POST', `/object/sign/${objectPath(key)}`,
        JSON.stringify({ expiresIn: SIGNED_URL_SECONDS }), { 'content-type': 'application/json' });
      const { signedURL } = (await res.json()) as { signedURL: string };
      return base + signedURL;
    },
  };
}

async function supabaseCall(
  base: string, key: string, method: string, path: string, body: string | Uint8Array | undefined, headers: Record<string, string>,
): Promise<Response> {
  const res = await fetch(base + path, {
    method,
    body,
    headers: { apikey: key, authorization: `Bearer ${key}`, ...headers },
  });
  if (!res.ok) throw new Error(`Supabase Storage ${method} ${path}: ${res.status} ${await res.text()}`);
  return res;
}

/** Creates the private photo bucket if the project does not have it yet. */
export async function ensureSupabaseBucket({ url, secretKey, bucket }: SupabaseStorageConfig): Promise<'exists' | 'created'> {
  const base = `${url.replace(/\/+$/, '')}/storage/v1`;
  const found = await fetch(`${base}/bucket/${encodeURIComponent(bucket)}`, {
    headers: { apikey: secretKey, authorization: `Bearer ${secretKey}` },
  });
  if (found.ok) return 'exists';
  await supabaseCall(base, secretKey, 'POST', '/bucket', JSON.stringify({
    id: bucket,
    name: bucket,
    public: false,
    file_size_limit: 15 * 1024 * 1024,
    allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
  }), { 'content-type': 'application/json' });
  return 'created';
}
