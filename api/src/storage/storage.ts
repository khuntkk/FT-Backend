// Where photo bytes live. Local disk for development and a single server;
// object storage (S3 or compatible, private, signed URLs) is open decision
// #3 in the handover and slots in behind this interface.
//
// A signed URL here is the API's own /files/raw/<key>?exp=&sig=, an HMAC of
// the key and expiry, so a photo can be fetched by an <img> without a token
// and stops working after a few minutes.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface Storage {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
  /** A URL that serves the file for a few minutes, relative to the API's origin. */
  signedPath(key: string, now?: number): string;
  /** Whether a signed path's signature and expiry hold. */
  verify(key: string, exp: string, sig: string, now?: number): boolean;
}

const SIGNED_URL_SECONDS = 10 * 60;

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
    async get(key) {
      try {
        return await readFile(pathOf(key));
      } catch {
        return null;
      }
    },
    async remove(key) {
      await rm(pathOf(key), { force: true });
    },
    signedPath(key, now = Date.now()) {
      const exp = Math.floor(now / 1000) + SIGNED_URL_SECONDS;
      return `/files/raw/${key}?exp=${exp}&sig=${sign(key, exp)}`;
    },
    verify(key, exp, sig, now = Date.now()) {
      const e = Number(exp);
      if (!Number.isInteger(e) || e * 1000 < now) return false;
      const want = Buffer.from(sign(key, e));
      const got = Buffer.from(sig ?? '');
      return want.length === got.length && timingSafeEqual(want, got);
    },
  };
}
