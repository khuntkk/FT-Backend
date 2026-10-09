// Builds the HTTP app. server.ts runs it; the tests build it against a
// throwaway database.

import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import type { Config } from './config.ts';
import type { Db } from './db/db.ts';
import { ApiError, errorBody, fromDatabase } from './http/errors.ts';
import { EventBus } from './http/events.ts';
import { registerRoutes } from './http/router.ts';
import { ajvOptions, sharedSchema } from './http/schemas.ts';
import type { Services } from './http/types.ts';
import { handlers } from './handlers/index.ts';
import { localStorage, supabaseStorage, type Storage } from './storage/storage.ts';
import { MAX_FILE_BYTES } from './services/files.ts';

export interface AppDeps {
  config: Config;
  db: Db;
  storage?: Storage;
  events?: EventBus;
  /** Per-IP requests a minute on the unauthenticated POST routes (default 30). */
  unauthLimit?: number;
}

export async function buildApp({ config, db, storage, events, unauthLimit }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    ajv: ajvOptions,
    trustProxy: config.trustProxy,
    // Request ids go into the log and into audit_log.request_id.
    genReqId: () => crypto.randomUUID(),
    // Caddy keeps upstream sockets 2 minutes; Node must close later than that.
    keepAliveTimeout: 130_000,
    requestTimeout: 120_000,
  });
  const services: Services = {
    config,
    storage: storage ?? (config.supabase
      ? supabaseStorage(config.supabase)
      : localStorage(config.filesDir, config.jwtSecret)),
    events: events ?? new EventBus(),
  };

  // An empty body labelled JSON (a DELETE from some HTTP clients) is no body,
  // not a malformed one.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = String(body);
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch (e) {
      (e as { statusCode?: number }).statusCode = 400;
      done(e as Error, undefined);
    }
  });

  app.addSchema(sharedSchema);
  // attachFieldsToBody reads the upload in preValidation, before the router
  // opens the database transaction, so a slow upload holds no connection.
  await app.register(multipart, { attachFieldsToBody: 'keyValues', limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
  // global: false: only routes with config.rateLimit are limited (router.ts).
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) =>
      new ApiError('rate_limited', 'Too many requests.', { retryAfter: Math.ceil(ctx.ttl / 1000) }),
  });

  // Ids are minted here, never taken from the client.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  // Every answer is private; the one that sets its own cache-control keeps it.
  // While shutting down, tell clients to drop the connection.
  let closing = false;
  app.addHook('onSend', async (_req, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    if (closing) reply.header('connection', 'close');
  });
  // preClose runs before the server stops accepting; onClose would be too late
  // for the open event streams, which would hold the close until they ended.
  app.addHook('preClose', async () => {
    closing = true;
    services.events.endStreams();
  });

  app.setErrorHandler((err: any, req, reply) => {
    const known = err instanceof ApiError ? err : fromDatabase(err);
    if (known) return reply.code(known.status).send(errorBody(known));
    if (err.validation) {
      const fields: Record<string, string> = {};
      for (const v of err.validation) {
        const at = v.params?.missingProperty
          ? `${v.instancePath}/${v.params.missingProperty}`
          : v.instancePath || v.params?.additionalProperty || '';
        fields[`${err.validationContext}${at}`.replace(/\//g, '.')] = v.message ?? 'invalid';
      }
      return reply.code(400).send({ error: { code: 'validation_failed', message: err.message, details: { fields } } });
    }
    if (err.code === 'FST_REQ_FILE_TOO_LARGE' || err.code === 'FST_FILES_LIMIT') {
      return reply.code(413).send({ error: { code: 'file_too_large', message: 'Over 15 MB.' } });
    }
    if (typeof err.statusCode === 'number' && err.statusCode < 500) {
      // Malformed JSON, a wrong content type and the like.
      return reply.code(400).send({ error: { code: 'validation_failed', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong.' } });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: `${req.method} ${req.url} is not a route.` } }));

  app.get('/health', async () => ({ ok: true }));

  // The web admin panel calls from its own origin when it is not served
  // behind the API's. Only the origins in CORS_ORIGINS; tokens travel in the
  // Authorization header, so no cookies and no credentials mode.
  const allowed = new Set(config.corsOrigins);
  if (allowed.size) {
    app.addHook('onRequest', async (req, reply) => {
      const origin = req.headers.origin;
      if (!origin || !allowed.has(origin)) return;
      reply.header('access-control-allow-origin', origin).header('vary', 'Origin')
        .header('access-control-expose-headers', 'x-request-id');
      if (req.method === 'OPTIONS') {
        return reply
          .header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE')
          .header('access-control-allow-headers', 'authorization, content-type, idempotency-key')
          .header('access-control-max-age', '600')
          .code(204)
          .send();
      }
    });
  }

  // Local disk's signed photo URLs (storage.ts): no token, the signature is the permission.
  const local = services.storage.local;
  if (local) {
    app.get('/files/raw/*', async (req, reply) => {
      const key = (req.params as { '*': string })['*'];
      const { exp, sig } = req.query as { exp?: string; sig?: string };
      if (!local.verify(key, exp ?? '', sig ?? '')) {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'Link expired or invalid.' } });
      }
      const bytes = await local.get(key);
      if (!bytes) return reply.code(404).send({ error: { code: 'not_found', message: 'No such file.' } });
      const type = key.endsWith('.png') ? 'image/png' : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      return reply.header('cache-control', 'private, max-age=600').type(type).send(bytes);
    });
  }

  registerRoutes(app, db, services, handlers, unauthLimit);
  return app;
}
