import { todayIn, type RouteKey } from '@stitchflow/contract';
import type { MemberCall, MemberHandlers } from '../http/types.ts';
import * as shifts from '../services/shifts.ts';

/**
 * Every schedule change is destructive and audited: the router writes the
 * row, this fills in the set Settings showed before and shows after.
 */
async function change<K extends RouteKey, T>(c: MemberCall<K>, work: (today: string) => Promise<T>): Promise<T> {
  const today = todayIn(c.member.timezone);
  const before = await shifts.editable(c.tx, today);
  const result = await work(today);
  const after = await shifts.editable(c.tx, today);
  c.audit({ entityType: 'shift', before, after });
  c.changed('shifts', after.map((s) => s.id));
  return result;
}

export const shiftsHandlers: MemberHandlers<
  | 'GET /v1/shifts' | 'GET /v1/shifts/current' | 'GET /v1/shifts/editable'
  | 'GET /v1/shifts/earliest-effective-date' | 'GET /v1/shifts/:id'
  | 'PUT /v1/shifts/scheme' | 'POST /v1/shifts' | 'PATCH /v1/shifts/:id' | 'POST /v1/shifts/:id/retire'
  | 'PUT /v1/shifts/timings' | 'PUT /v1/shifts/restore'
> = {
  'GET /v1/shifts': (c) => shifts.on(c.tx, c.query.on),
  'GET /v1/shifts/current': (c) => shifts.on(c.tx, todayIn(c.member.timezone)),
  'GET /v1/shifts/editable': (c) => shifts.editable(c.tx, todayIn(c.member.timezone)),
  'GET /v1/shifts/earliest-effective-date': async (c) => ({
    date: await shifts.earliestEffectiveDate(c.tx, todayIn(c.member.timezone), c.query.shiftIds),
  }),
  'GET /v1/shifts/:id': (c) => shifts.get(c.tx, c.params.id),
  'PUT /v1/shifts/scheme': async (c) => {
    const set = await change(c, (today) => shifts.applyScheme(c.tx, c.member, today, c.body));
    c.changed('property_settings', [c.member.propertyId]);
    return set;
  },
  'POST /v1/shifts': (c) => change(c, (today) => shifts.create(c.tx, c.member, today, c.body)),
  'PATCH /v1/shifts/:id': (c) => change(c, (today) => shifts.update(c.tx, c.member, today, c.params.id, c.body)),
  'POST /v1/shifts/:id/retire': (c) => change(c, (today) => shifts.retire(c.tx, c.member, today, c.params.id)),
  'PUT /v1/shifts/timings': (c) => change(c, (today) => shifts.applyTimings(c.tx, c.member, today, c.body.shifts)),
  'PUT /v1/shifts/restore': (c) => change(c, (today) => shifts.restore(c.tx, c.member, today, c.body)),
};
