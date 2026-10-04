import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addDays, daysInMonth, isDateOnly, monthRange, parseDateOnly, roundMoney, toDateOnly, toMonth, todayIn } from '../dist/index.js';

test('a date travels as its calendar fields, never through UTC', () => {
  const d = new Date(2026, 8, 27, 0, 0, 0); // local midnight
  assert.equal(toDateOnly(d), '2026-09-27');
  assert.equal(toDateOnly(parseDateOnly('2026-09-27')), '2026-09-27');
});

test('impossible dates are refused', () => {
  assert.equal(isDateOnly('2026-02-30'), false);
  assert.equal(isDateOnly('2026-9-7'), false);
  assert.equal(isDateOnly('2024-02-29'), true);
});

test('months', () => {
  assert.deepEqual(monthRange('2026-12'), { start: '2026-12-01', end: '2027-01-01' });
  assert.equal(daysInMonth('2026-02'), 28);
  assert.equal(daysInMonth('2024-02'), 29);
  assert.equal(toMonth('2026-09-27'), '2026-09');
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
});

test("today is the property's own date", () => {
  // 20:00 UTC on the 27th is already the 28th in India.
  const late = new Date(Date.UTC(2026, 8, 27, 20, 0, 0));
  assert.equal(todayIn('Asia/Kolkata', late), '2026-09-28');
  assert.equal(todayIn('UTC', late), '2026-09-27');
});

test('money rounds to the paisa', () => {
  assert.equal(roundMoney(17000 / 30 * 26), 14733.33);
  assert.equal(roundMoney(0.1 + 0.2), 0.3);
});
