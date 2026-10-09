import type { FastifyRequest } from 'fastify';
import type { FilePurpose } from '@stitchflow/contract';
import { ApiError } from '../http/errors.ts';
import { requireMember } from '../http/router.ts';
import type { SessionHandlers } from '../http/types.ts';
import * as files from '../services/files.ts';

const PURPOSES = Object.keys(files.UPLOAD_ACTION);

/** The API's own origin as the client reached it: local disk's signed URLs are served here. */
const origin = (req: FastifyRequest) => `${req.protocol}://${req.host}`;

export const fileHandlers: SessionHandlers<'POST /v1/files' | 'GET /v1/files/:fileId'> = {
  'POST /v1/files': async (c) => {
    const member = requireMember(c.member);
    if (!c.req.isMultipart()) {
      throw new ApiError('validation_failed', 'Send multipart/form-data.', { fields: { body: 'multipart' } });
    }
    // @fastify/multipart (attachFieldsToBody: 'keyValues') has read the body
    // before the transaction opened: fields are strings, the file a Buffer.
    const body = (c.req.body ?? {}) as { purpose?: unknown; file?: unknown };
    const purpose = typeof body.purpose === 'string' ? body.purpose : undefined;
    const bytes = Buffer.isBuffer(body.file) ? body.file : undefined;
    if (!purpose || !PURPOSES.includes(purpose)) {
      throw new ApiError('validation_failed', 'purpose is machinePhoto, staffPhoto or slipPhoto.', {
        fields: { purpose: 'required' },
      });
    }
    if (!bytes) throw new ApiError('validation_failed', 'No file.', { fields: { file: 'required' } });
    await c.assertCan(files.UPLOAD_ACTION[purpose as FilePurpose]);
    return files.upload(c.tx, c.services.storage, member, purpose as FilePurpose, bytes, origin(c.req));
  },

  'GET /v1/files/:fileId': async (c) => {
    requireMember(c.member);
    const f = await files.find(c.tx, c.params.fileId);
    const tries = files.VIEW_ACTIONS[f.purpose];
    let refused: unknown;
    for (const action of tries) {
      try {
        await c.assertCan(action);
        refused = undefined;
        break;
      } catch (e) {
        refused = e;
      }
    }
    if (refused) throw refused;
    return c.reply.redirect(await c.services.storage.signedUrl(f.key, origin(c.req)), 302);
  },
};
