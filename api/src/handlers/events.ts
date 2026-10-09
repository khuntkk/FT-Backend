// GET /v1/events — Server-Sent Events: after each write in the property,
// { "table": "...", "ids": [...] }, so the apps refresh the stream that shows
// it instead of polling. The request's transaction ends as soon as the
// stream is open; the stream itself holds no connection to the database.

import { requireMember } from '../http/router.ts';
import type { SessionHandlers } from '../http/types.ts';

const HEARTBEAT_MS = 25_000;

// The table each notice names, and the action that lets a member see it.
const VIEW_ACTION: Record<string, string> = {
  production_entries: 'production.view', attendance_marks: 'attendance.view', machines: 'machines.view',
  shifts: 'shifts.view', advances: 'advances.view', salary_payments: 'payroll.view',
  bonus_rules: 'bonus_rules.view', property_members: 'users.view', staff: 'staff.view',
};
// Slips and attendance name staff, so their viewers hear of staff changes too.
const STAFF_ALSO = ['production.view', 'attendance.view'];
// Every member hears these.
const ALWAYS = ['property_settings', 'properties'];

export const eventHandlers: SessionHandlers<'GET /v1/events'> = {
  'GET /v1/events': async (c) => {
    const member = requireMember(c.member);
    const { reply, req } = c;
    const actions = [...new Set([...Object.values(VIEW_ACTION), ...STAFF_ALSO])];
    const can = await c.tx.one<{ actions: string[] }>(
      `select coalesce(array_agg(a), '{}') as actions from unnest($2::text[]) a where fn_member_can($1, a)`,
      [member.memberId, actions],
    );
    const allowed = new Set(can!.actions);
    const tables = new Set(ALWAYS);
    for (const [table, action] of Object.entries(VIEW_ACTION)) if (allowed.has(action)) tables.add(table);
    if (STAFF_ALSO.some((a) => allowed.has(a))) tables.add('staff');
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const untrack = c.services.events.track(reply.raw, member.memberId);
    reply.raw.write(': connected\n\n');
    const stop = c.services.events.listen(member.propertyId, { memberId: member.memberId, tables }, (n) => {
      reply.raw.write(`event: change\ndata: ${JSON.stringify(n)}\n\n`);
    });
    const beat = setInterval(() => reply.raw.write(': ping\n\n'), HEARTBEAT_MS);
    req.raw.on('close', () => {
      clearInterval(beat);
      untrack();
      stop();
    });
    return reply;
  },
};
