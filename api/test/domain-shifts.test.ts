// Ported case by case from packages/sf_core/test/shift_schedule_test.dart.
// Dart's DateTime inputs become a date and a minute of the day; the English
// messages it matched on become the problem kinds and smartAdjustNotes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasAdjustableStart, MINUTES_PER_DAY, orderedCycle, planSmartAdjust, presetShifts, shiftAtTime, shiftContains,
  shiftEndMinute, shiftProblemMessage, smartAdjustNotes, validateShiftCycle, workingDayAt,
} from '../src/domain/shifts.ts';

function shift(name: string, o: { startHour: number; hours: number; order?: number; id?: number; extra?: number }) {
  return {
    id: o.id ?? 1,
    name,
    startMinute: o.startHour * 60 + (o.extra ?? 0),
    durationMinutes: o.hours * 60,
    sortOrder: o.order ?? 0,
  };
}

const at = (h: number, m = 0) => h * 60 + m;
const names = (xs: { name: string }[]) => xs.map((s) => s.name);
const kinds = (xs: { kind: string }[]) => xs.map((p) => p.kind);

describe('shift boundaries', () => {
  it('a daytime shift ends the same day', () => {
    assert.equal(shiftEndMinute(shift('Day', { startHour: 8, hours: 12 })), 20 * 60);
  });

  it('a shift crossing midnight wraps', () => {
    assert.equal(shiftEndMinute(shift('Night', { startHour: 20, hours: 12 })), 8 * 60);
  });

  it('contains works either side of midnight', () => {
    const night = shift('Night', { startHour: 20, hours: 12 });
    assert.equal(shiftContains(night, 21 * 60), true, '9pm');
    assert.equal(shiftContains(night, 2 * 60), true, '2am');
    assert.equal(shiftContains(night, 8 * 60), false, '8am is the end');
    assert.equal(shiftContains(night, 12 * 60), false, 'midday');
  });

  it('the start minute is inside, the end minute is not', () => {
    const day = shift('Day', { startHour: 8, hours: 12 });
    assert.equal(shiftContains(day, 8 * 60), true);
    assert.equal(shiftContains(day, 20 * 60), false);
  });
});

describe('shiftAtTime', () => {
  const cycle = [
    shift('Day', { startHour: 8, hours: 12, id: 1, order: 0 }),
    shift('Night', { startHour: 20, hours: 12, id: 2, order: 1 }),
  ];

  it('picks the shift running now', () => {
    assert.equal(shiftAtTime(cycle, at(10))?.name, 'Day');
    assert.equal(shiftAtTime(cycle, at(23))?.name, 'Night');
    assert.equal(shiftAtTime(cycle, at(3))?.name, 'Night');
  });

  it('returns null when nothing covers that time', () => {
    assert.equal(shiftAtTime([shift('Morning', { startHour: 8, hours: 4 })], at(18)), null);
  });

  it('an empty cycle has no current shift', () => {
    assert.equal(shiftAtTime([], at(10)), null);
  });
});

describe('orderedCycle', () => {
  it('runs from the first shift, not from midnight', () => {
    const shifts = [
      shift('A', { startHour: 15, hours: 8, id: 1, order: 0 }),
      shift('B', { startHour: 23, hours: 8, id: 2, order: 1 }),
      shift('C', { startHour: 7, hours: 8, id: 3, order: 2 }),
    ];
    assert.deepEqual(names(orderedCycle(shifts)), ['A', 'B', 'C']);
  });

  it('sorts out-of-order rows by where they fall in the cycle', () => {
    const shifts = [
      shift('C', { startHour: 7, hours: 8, id: 3, order: 2 }),
      shift('A', { startHour: 15, hours: 8, id: 1, order: 0 }),
      shift('B', { startHour: 23, hours: 8, id: 2, order: 1 }),
    ];
    assert.deepEqual(names(orderedCycle(shifts)), ['A', 'B', 'C']);
  });

  it('an empty list stays empty', () => {
    assert.deepEqual(orderedCycle([]), []);
  });

  it('the anchor can be any time, not a round hour', () => {
    const shifts = [
      shift('A', { startHour: 6, extra: 45, hours: 7, id: 1, order: 0 }),
      shift('B', { startHour: 13, extra: 45, hours: 7, id: 2, order: 1 }),
      shift('C', { startHour: 20, extra: 45, hours: 7, id: 3, order: 2 }),
    ];
    assert.deepEqual(names(orderedCycle(shifts)), ['A', 'B', 'C']);
    assert.deepEqual(validateShiftCycle(shifts), []);
    assert.equal(shiftAtTime(shifts, at(2, 30))?.name, 'C', 'the 8:45pm shift runs into the small hours');
  });

  it('a cycle can start one minute past midnight', () => {
    const shifts = [
      shift('Early', { startHour: 0, extra: 1, hours: 12, id: 1, order: 0 }),
      shift('Late', { startHour: 12, extra: 1, hours: 12, id: 2, order: 1 }),
    ];
    assert.deepEqual(validateShiftCycle(shifts), []);
  });
});

describe('validateShiftCycle', () => {
  it('day and night are sound', () => {
    assert.deepEqual(validateShiftCycle([
      shift('Day', { startHour: 8, hours: 12, id: 1, order: 0 }),
      shift('Night', { startHour: 20, hours: 12, id: 2, order: 1 }),
    ]), []);
  });

  it('three eight-hour shifts are sound', () => {
    assert.deepEqual(validateShiftCycle([
      shift('Morning', { startHour: 8, hours: 8, id: 1, order: 0 }),
      shift('Evening', { startHour: 16, hours: 8, id: 2, order: 1 }),
      shift('Night', { startHour: 0, hours: 8, id: 3, order: 2 }),
    ]), []);
  });

  it('a cycle anchored at 3pm is sound', () => {
    assert.deepEqual(validateShiftCycle([
      shift('First', { startHour: 15, hours: 8, id: 1, order: 0 }),
      shift('Second', { startHour: 23, hours: 8, id: 2, order: 1 }),
      shift('Third', { startHour: 7, hours: 8, id: 3, order: 2 }),
    ]), []);
  });

  it('overlapping shifts are rejected', () => {
    const problems = validateShiftCycle([
      shift('Day', { startHour: 8, hours: 12, id: 1, order: 0 }),
      shift('Night', { startHour: 18, hours: 12, id: 2, order: 1 }),
    ]);
    assert.deepEqual(problems, [{ kind: 'overlap', shift: 'Day', other: 'Night' }]);
    assert.match(shiftProblemMessage(problems[0]), /overlap/);
  });

  it('a gap is allowed — a unit need not run all day', () => {
    assert.deepEqual(validateShiftCycle([
      shift('Morning', { startHour: 8, hours: 4, id: 1, order: 0 }),
      shift('Evening', { startHour: 16, hours: 4, id: 2, order: 1 }),
    ]), []);
  });

  it('more than 24 hours is rejected', () => {
    const problems = validateShiftCycle([
      shift('A', { startHour: 0, hours: 13, id: 1, order: 0 }),
      shift('B', { startHour: 13, hours: 13, id: 2, order: 1 }),
    ]);
    assert.ok(kinds(problems).includes('totalOverDay'));
    assert.ok(problems.some((p) => shiftProblemMessage(p).includes('24 hours')));
  });

  it('a zero-length shift is rejected', () => {
    const problems = validateShiftCycle([shift('Nothing', { startHour: 8, hours: 0 })]);
    assert.deepEqual(problems, [{ kind: 'noLength', shift: 'Nothing', other: null }]);
    assert.match(shiftProblemMessage(problems[0]), /no length/);
  });

  it('the last shift may not run back over the first', () => {
    const problems = validateShiftCycle([
      shift('A', { startHour: 15, hours: 8, id: 1, order: 0 }),
      shift('B', { startHour: 23, hours: 8, id: 2, order: 1 }),
      shift('C', { startHour: 7, hours: 10, id: 3, order: 2 }),
    ]);
    assert.ok(problems.some((p) => p.kind === 'runsPastStart' && p.shift === 'C' && p.other === 'A'));
    assert.ok(problems.some((p) => shiftProblemMessage(p).includes('runs past')));
  });

  it('an empty cycle is called out', () => {
    const problems = validateShiftCycle([]);
    assert.deepEqual(kinds(problems), ['empty']);
    assert.match(shiftProblemMessage(problems[0]), /at least one/);
  });

  it('a single 24-hour shift is sound', () => {
    assert.deepEqual(validateShiftCycle([shift('All day', { startHour: 6, hours: 24 })]), []);
  });

  it('a shift longer than a day is rejected', () => {
    const tooLong = { id: 1, name: 'Endless', startMinute: 6 * 60, durationMinutes: 24 * 60 + 45, sortOrder: 0 };
    const problems = validateShiftCycle([tooLong]);
    assert.deepEqual(kinds(problems), ['longerThanDay']);
    assert.match(shiftProblemMessage(problems[0]), /longer than a day/);
  });
});

describe('presets', () => {
  it('day and night', () => {
    const preset = presetShifts('dayNight');
    assert.deepEqual(names(preset), ['Day', 'Night']);
    assert.ok(preset.every((p) => p.durationMinutes === 12 * 60));
  });

  it('three shifts cover the full day', () => {
    const preset = presetShifts('threeShift');
    assert.deepEqual(names(preset), ['Morning', 'Evening', 'Night']);
    assert.equal(preset.reduce((sum, p) => sum + p.durationMinutes, 0), MINUTES_PER_DAY);
  });

  it('three shifts can start at six', () => {
    const preset = presetShifts('threeShift', 6 * 60);
    assert.deepEqual(preset.map((p) => p.startMinute), [6 * 60, 14 * 60, 22 * 60]);
    assert.ok(preset.every((p) => p.durationMinutes === 8 * 60));
  });

  it('day and night follow the same anchor', () => {
    assert.deepEqual(presetShifts('dayNight', 7 * 60).map((p) => p.startMinute), [7 * 60, 19 * 60]);
  });

  it('an anchor late in the day wraps the later shifts round', () => {
    assert.deepEqual(presetShifts('threeShift', 20 * 60).map((p) => p.startMinute), [20 * 60, 4 * 60, 12 * 60]);
  });

  it('an anchored cycle is still a sound cycle', () => {
    for (const start of [0, 6 * 60, 15 * 60 + 30, 23 * 60 + 45]) {
      const shifts = presetShifts('threeShift', start).map((p, i) => ({ ...p, id: i + 1, sortOrder: i }));
      assert.deepEqual(validateShiftCycle(shifts), [], `anchored at ${start} minutes`);
    }
  });

  it('custom has no preset to apply', () => {
    assert.deepEqual(presetShifts('manual'), []);
  });

  it('only custom has no preset start to adjust', () => {
    assert.equal(hasAdjustableStart('dayNight'), true);
    assert.equal(hasAdjustableStart('threeShift'), true);
    assert.equal(hasAdjustableStart('manual'), false);
  });
});

describe('smart adjust', () => {
  it('sound shifts need no adjusting', () => {
    assert.equal(planSmartAdjust([
      shift('Day', { startHour: 8, hours: 12, id: 1, order: 0 }),
      shift('Night', { startHour: 20, hours: 12, id: 2, order: 1 }),
    ]), null);
  });

  it('an empty set has nothing to adjust', () => {
    assert.equal(planSmartAdjust([]), null);
  });

  it('equal-length overlaps are fixed exactly', () => {
    const plan = planSmartAdjust([
      shift('A', { startHour: 6, hours: 8, id: 1, order: 0 }),
      shift('B', { startHour: 12, hours: 8, id: 2, order: 1 }),
      shift('C', { startHour: 18, hours: 8, id: 3, order: 2 }),
    ])!;
    assert.equal(plan.confidence, 'exact');
    assert.deepEqual(plan.shifts.map((s) => s.startMinute), [6 * 60, 14 * 60, 22 * 60]);
    assert.ok(plan.shifts.every((s) => s.durationMinutes === 8 * 60));
  });

  it('the cycle keeps the start time it had', () => {
    const plan = planSmartAdjust([
      shift('A', { startHour: 15, hours: 8, id: 1, order: 0 }),
      shift('B', { startHour: 20, hours: 8, id: 2, order: 1 }),
      shift('C', { startHour: 2, hours: 8, id: 3, order: 2 }),
    ])!;
    assert.equal(plan.shifts[0].startMinute, 15 * 60, 'a 3pm unit stays a 3pm unit');
    assert.deepEqual(plan.shifts.map((s) => s.startMinute), [15 * 60, 23 * 60, 7 * 60]);
  });

  it('uneven lengths are laid out but flagged for review', () => {
    const plan = planSmartAdjust([
      shift('Long', { startHour: 8, hours: 10, id: 1, order: 0 }),
      shift('Short', { startHour: 15, hours: 6, id: 2, order: 1 }),
    ])!;
    assert.equal(plan.confidence, 'needsReview');
    assert.deepEqual(plan.shifts.map((s) => s.startMinute), [8 * 60, 18 * 60]);
    assert.deepEqual(plan.shifts.map((s) => s.durationMinutes), [10 * 60, 6 * 60], 'lengths are kept when they fit');
    assert.ok(smartAdjustNotes(plan).some((n) => n.includes('different lengths')));
  });

  it('a partly covered day is called out', () => {
    const plan = planSmartAdjust([
      shift('A', { startHour: 8, hours: 6, id: 1, order: 0 }),
      shift('B', { startHour: 10, hours: 6, id: 2, order: 1 }),
    ])!;
    assert.ok(smartAdjustNotes(plan).some((n) => n.includes('unassigned')));
  });

  it('shifts totalling more than a day are shortened evenly', () => {
    const plan = planSmartAdjust([
      shift('A', { startHour: 0, hours: 10, id: 1, order: 0 }),
      shift('B', { startHour: 8, hours: 10, id: 2, order: 1 }),
      shift('C', { startHour: 16, hours: 10, id: 3, order: 2 }),
    ])!;
    assert.equal(plan.confidence, 'needsReview');
    assert.ok(plan.shifts.every((s) => s.durationMinutes === 8 * 60));
    assert.deepEqual(plan.shifts.map((s) => s.startMinute), [0, 8 * 60, 16 * 60]);
    assert.ok(smartAdjustNotes(plan).some((n) => n.includes('more than')));
  });

  it('an uneven split gives the remainder to the first shift', () => {
    const plan = planSmartAdjust(
      Array.from({ length: 7 }, (_, i) => shift(`S${i}`, { startHour: 0, hours: 5, id: i + 1, order: i })),
    )!;
    assert.equal(plan.shifts.reduce((sum, s) => sum + s.durationMinutes, 0), MINUTES_PER_DAY, 'the day is fully covered');
    assert.ok(plan.shifts[0].durationMinutes > plan.shifts[plan.shifts.length - 1].durationMinutes);
  });

  it('the adjusted result always validates', () => {
    const cases = [
      [
        shift('A', { startHour: 6, hours: 8, id: 1, order: 0 }),
        shift('B', { startHour: 10, hours: 8, id: 2, order: 1 }),
      ],
      [
        shift('A', { startHour: 22, hours: 10, id: 1, order: 0 }),
        shift('B', { startHour: 2, hours: 10, id: 2, order: 1 }),
        shift('C', { startHour: 10, hours: 10, id: 3, order: 2 }),
      ],
      [shift('Solo', { startHour: 13, hours: 30, id: 1, order: 0 })],
    ];
    for (const input of cases) {
      const adjusted = planSmartAdjust(input)!.shifts.map((p, i) => ({ ...p, sortOrder: i }));
      assert.deepEqual(validateShiftCycle(adjusted), [], 'adjusting must always produce a sound cycle');
    }
  });
});

describe('workingDayAt', () => {
  const dayNight = [
    shift('Day', { startHour: 8, hours: 12, id: 1, order: 0 }),
    shift('Night', { startHour: 20, hours: 12, id: 2, order: 1 }),
  ];

  it('the small hours belong to the night that began the evening before', () => {
    assert.equal(workingDayAt(dayNight, '2026-09-28', at(2)), '2026-09-27');
  });

  it('from the first shift of the cycle it is the calendar date', () => {
    assert.equal(workingDayAt(dayNight, '2026-09-28', at(8)), '2026-09-28');
    assert.equal(workingDayAt(dayNight, '2026-09-28', at(21)), '2026-09-28');
  });

  it('a cycle anchored at 3pm runs to 3pm the next day', () => {
    const afternoon = [
      shift('A', { startHour: 15, hours: 12, id: 1, order: 0 }),
      shift('B', { startHour: 3, hours: 12, id: 2, order: 1 }),
    ];
    assert.equal(workingDayAt(afternoon, '2026-03-01', at(14, 59)), '2026-02-28');
    assert.equal(workingDayAt(afternoon, '2026-03-01', at(15)), '2026-03-01');
  });

  it('with no shifts it is the calendar date', () => {
    assert.equal(workingDayAt([], '2026-09-28', at(2)), '2026-09-28');
  });
});
