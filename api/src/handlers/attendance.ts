import type { MemberHandlers } from '../http/types.ts';
import * as attendance from '../services/attendance.ts';

export const attendanceHandlers: MemberHandlers<
  | 'GET /v1/attendance/day' | 'GET /v1/attendance/daily' | 'GET /v1/staff/:id/attendance'
  | 'PUT /v1/attendance/mark' | 'PUT /v1/attendance/marks' | 'POST /v1/attendance/mark-all'
  | 'DELETE /v1/attendance/mark' | 'POST /v1/attendance/undo-mark-all' | 'POST /v1/attendance/clear-month'
> = {
  'GET /v1/attendance/day': (c) => attendance.day(c.tx, c.query.date, c.query.category),
  'GET /v1/attendance/daily': (c) => attendance.daily(c.tx, c.query.month),
  'GET /v1/staff/:id/attendance': (c) =>
    attendance.forStaff(c.tx, c.member, c.params.id, c.query.from, c.query.to),
  'PUT /v1/attendance/mark': async (c) => {
    await attendance.mark(c.tx, c.member, c.body.staffId, c.body.date, c.body.status);
    c.changed('attendance_marks', []);
  },
  'PUT /v1/attendance/marks': async (c) => {
    await attendance.markMany(c.tx, c.member, c.body.staffId, c.body.dates, c.body.status);
    c.changed('attendance_marks', []);
  },
  'POST /v1/attendance/mark-all': async (c) => {
    await attendance.markAll(c.tx, c.member, c.body.staffIds, c.body.date, c.body.status);
    c.changed('attendance_marks', []);
  },
  'DELETE /v1/attendance/mark': async (c) => {
    await attendance.unmark(c.tx, c.member, c.query.staffId, c.query.date);
    c.changed('attendance_marks', []);
  },
  'POST /v1/attendance/undo-mark-all': async (c) => {
    await attendance.undoMarkAll(c.tx, c.member, c.body.staffIds, c.body.date);
    c.changed('attendance_marks', []);
  },
  'POST /v1/attendance/clear-month': async (c) => {
    const before = await attendance.clearMonth(c.tx, c.member, c.body.staffId, c.body.month);
    c.audit({ entityType: 'attendance', entityId: c.body.staffId, before });
    c.changed('attendance_marks', []);
  },
};
