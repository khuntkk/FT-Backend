// GET /v1/events — Server-Sent Events: after each write in the property,
// { "table": "...", "ids": [...] }, so the apps refresh the stream that shows
// it instead of polling. The request's transaction ends as soon as the
// stream is open; the stream itself holds no connection to the database.

import { requireMember } from '../http/router.ts';
import type { SessionHandlers } from '../http/types.ts';

const HEARTBEAT_MS = 25_000;

export const eventHandlers: SessionHandlers<'GET /v1/events'> = {
  'GET /v1/events': async (c) => {
    const member = requireMember(c.member);
    const { reply, req } = c;
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    const stop = c.services.events.listen(member.propertyId, (n) => {
      reply.raw.write(`event: change\ndata: ${JSON.stringify(n)}\n\n`);
    });
    const beat = setInterval(() => reply.raw.write(': ping\n\n'), HEARTBEAT_MS);
    req.raw.on('close', () => {
      clearInterval(beat);
      stop();
    });
    return reply;
  },
};
