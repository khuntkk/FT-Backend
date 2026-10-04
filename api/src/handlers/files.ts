import type { FastifyRequest } from 'fastify';
import type { FilePurpose } from '@stitchflow/contract';
import { ApiError } from '../http/errors.ts';
import { requireMember } from '../http/router.ts';
import type { SessionHandlers } from '../http/types.ts';
import * as files from '../services/files.ts';

const PURPOSES = Object.keys(files.UPLOAD_ACTION);

/** The API's own origin as the client reached it: signed URLs are served here. */
const origin = (req: FastifyRequest) => `${req.protocol}://${req.host}`;

export const fileHandlers: SessionHandlers<'POST /v1/files' | 'GET /v1/files/:fileId'> = {
  'POST /v1/files': async (c) => {
    const member = requireMember(c.member);
    if (!c.req.isMultipart()) {
      throw new ApiError('validation_failed', 'Send multipart/form-data.', { fields: { body: 'multipart' } });
    }
    let purpose: string | undefined;
    let bytes: Buffer | undefined;
    for await (const part of c.req.parts()) {
      if (part.type === 'file') bytes = await part.toBuffer();
      else if (part.fieldname === 'purpose') purpose = String(part.value);
    }
    if (!purpose || !PURPOSES.includes(purpose)) {
      throw new ApiError('validation_failed', 'purpose is machinePhoto, staffPhoto or slipPhoto.', {
        fields: { purpose: 'required' },
      });
    }
    if (!bytes) throw new ApiError('validation_failed', 'No file.', { fields: { file: 'required' } });
    await c.assertCan(files.UPLOAD_ACTION[purpose as FilePurpose]);
    const ref = await files.upload(c.tx, c.services.storage, member, purpose as FilePurpose, bytes);
    return { ...ref, url: origin(c.req) + ref.url };
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
    return c.reply.redirect(origin(c.req) + c.services.storage.signedPath(f.key), 302);
  },
};
