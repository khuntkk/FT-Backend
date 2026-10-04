// Shift rules, ported from packages/sf_core/lib/src/domain/shift_schedule.dart
// in the apps repo. Pure functions: no database.

import { addDays, type ShiftProblem, type ShiftScheme } from '@stitchflow/contract';

/** Minutes in a day. */
export const MINUTES_PER_DAY = 24 * 60;

/** When a unit's day begins, unless it says otherwise: 8am. */
export const DEFAULT_DAY_START = 8 * 60;

export interface ShiftSpec {
  name: string;
  startMinute: number;
  durationMinutes: number;
}

/**
 * The preset shifts for a scheme. dayStartMinute anchors the cycle: a unit
 * whose day begins at 6am gets shifts from 6am. `manual` has no preset.
 */
export function presetShifts(scheme: ShiftScheme, dayStartMinute = DEFAULT_DAY_START): ShiftSpec[] {
  const at = (offsetHours: number) => (dayStartMinute + offsetHours * 60) % MINUTES_PER_DAY;
  switch (scheme) {
    case 'dayNight':
      return [
        { name: 'Day', startMinute: at(0), durationMinutes: 12 * 60 },
        { name: 'Night', startMinute: at(12), durationMinutes: 12 * 60 },
      ];
    case 'threeShift':
      return [
        { name: 'Morning', startMinute: at(0), durationMinutes: 8 * 60 },
        { name: 'Evening', startMinute: at(8), durationMinutes: 8 * 60 },
        { name: 'Night', startMinute: at(16), durationMinutes: 8 * 60 },
      ];
    case 'manual':
      return [];
  }
}

/** Only a preset arrangement is built from one start time; custom has none to adjust. */
export const hasAdjustableStart = (scheme: ShiftScheme): boolean => scheme !== 'manual';

/** What the rules need of a shift: any version, or a timing not yet saved. */
export interface CycleShift {
  name: string;
  startMinute: number;
  durationMinutes: number;
  sortOrder: number;
}

// Dart's % never goes negative; JavaScript's does.
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** When a shift ends, wrapped into the same day: Night 20:00 + 12h ends at 08:00. */
export const shiftEndMinute = (s: CycleShift): number => mod(s.startMinute + s.durationMinutes, MINUTES_PER_DAY);

/** Whether a minute of the day falls inside the shift, allowing for one that crosses midnight. */
export function shiftContains(s: CycleShift, minuteOfDay: number): boolean {
  if (s.durationMinutes >= MINUTES_PER_DAY) return true;
  return mod(minuteOfDay - s.startMinute, MINUTES_PER_DAY) < s.durationMinutes;
}

/** The shift covering a minute of the day, or null when none does. */
export function shiftAtTime<T extends CycleShift>(shifts: T[], minuteOfDay: number): T | null {
  return shifts.find((s) => shiftContains(s, minuteOfDay)) ?? null;
}

/**
 * Shifts in the order they run, starting from the lowest sortOrder. The first
 * shift anchors the cycle: a unit whose day begins at 3pm has its shifts
 * measured from 3pm, not from midnight.
 */
export function orderedCycle<T extends CycleShift>(shifts: T[]): T[] {
  if (!shifts.length) return [];
  const byOrder = [...shifts].sort((a, b) => a.sortOrder - b.sortOrder);
  const anchor = byOrder[0].startMinute;
  const offset = (s: T) => mod(s.startMinute - anchor, MINUTES_PER_DAY);
  return byOrder.sort((a, b) => offset(a) - offset(b));
}

/**
 * The working day a local date and minute belong to. A cycle runs 24 hours
 * from its first shift, so with Day 08–20 and Night 20–08, two in the morning
 * is still the night that began the evening before.
 */
export function workingDayAt(shifts: CycleShift[], date: string, minuteOfDay: number): string {
  if (!shifts.length) return date;
  const anchor = orderedCycle(shifts)[0].startMinute;
  return minuteOfDay < anchor ? addDays(date, -1) : date;
}

/** The English wording of a problem, for logs; the apps word `kind` themselves. */
export function shiftProblemMessage(p: ShiftProblem): string {
  switch (p.kind) {
    case 'empty': return 'Add at least one shift.';
    case 'noLength': return `${p.shift} has no length.`;
    case 'longerThanDay': return `${p.shift} runs longer than a day.`;
    case 'startsOutsideDay': return `${p.shift} starts outside the day.`;
    case 'totalOverDay': return 'These shifts add up to more than 24 hours.';
    case 'overlap': return `${p.shift} and ${p.other} overlap.`;
    case 'runsPastStart': return `${p.shift} runs past the start of ${p.other}.`;
  }
}

const problem = (kind: ShiftProblem['kind'], shift: string | null = null, other: string | null = null): ShiftProblem =>
  ({ kind, shift, other });

/** Impossible lengths and starts, shift by shift. */
function lengthProblems(shifts: CycleShift[]): ShiftProblem[] {
  const problems: ShiftProblem[] = [];
  for (const s of shifts) {
    if (s.durationMinutes <= 0) problems.push(problem('noLength', s.name));
    else if (s.durationMinutes > MINUTES_PER_DAY) problems.push(problem('longerThanDay', s.name));
    if (s.startMinute < 0 || s.startMinute >= MINUTES_PER_DAY) problems.push(problem('startsOutsideDay', s.name));
  }
  return problems;
}

/**
 * What is wrong with a set of shifts; empty when the cycle is sound. Gaps are
 * allowed — a unit may genuinely not run at night — but overlaps are not,
 * because a slip would then belong to two shifts at once.
 */
export function validateShiftCycle(shifts: CycleShift[]): ShiftProblem[] {
  if (!shifts.length) return [problem('empty')];
  const problems = lengthProblems(shifts);
  if (problems.length) return problems;

  const total = shifts.reduce((sum, s) => sum + s.durationMinutes, 0);
  if (total > MINUTES_PER_DAY) problems.push(problem('totalOverDay'));

  const cycle = orderedCycle(shifts);
  const anchor = cycle[0].startMinute;
  const offset = (s: CycleShift) => mod(s.startMinute - anchor, MINUTES_PER_DAY);
  for (let i = 0; i < cycle.length - 1; i++) {
    const current = cycle[i];
    const next = cycle[i + 1];
    if (offset(current) + current.durationMinutes > offset(next)) {
      problems.push(problem('overlap', current.name, next.name));
    }
  }
  // The last shift must not run back over the first.
  const last = cycle[cycle.length - 1];
  if (offset(last) + last.durationMinutes > MINUTES_PER_DAY) {
    problems.push(problem('runsPastStart', last.name, cycle[0].name));
  }
  return problems;
}

/**
 * Whether the shifts actually clash, as opposed to being unfinished. An empty
 * set is not a clash — someone may be starting over — and nor is a gap.
 */
export const shiftCycleClashes = (shifts: CycleShift[]): boolean =>
  shifts.length > 0 && validateShiftCycle(shifts).length > 0;

export interface SmartAdjustPlan {
  /** The new timings, in the order they will run. */
  shifts: { id: number; name: string; startMinute: number; durationMinutes: number }[];
  /** exact: equal lengths that fit the day; needsReview: only the user knows if it is what they meant. */
  confidence: 'exact' | 'needsReview';
  /** The shifts added up to more than a day and each was cut to eachMinutes. */
  shortened: boolean;
  unevenLengths: boolean;
  /** What the shifts added up to before. */
  totalMinutes: number;
  /** How much of the day the adjusted shifts cover. */
  coveredMinutes: number;
  /** Each shift's new length when shortened; zero otherwise. */
  eachMinutes: number;
}

/** Lengths for the plan: kept when they fit the day, else the day shared out evenly (remainder to the first). */
function plannedLengths(cycle: CycleShift[], total: number): { lengths: number[]; each: number } {
  if (total <= MINUTES_PER_DAY) return { lengths: cycle.map((s) => s.durationMinutes), each: 0 };
  const each = Math.floor(MINUTES_PER_DAY / cycle.length);
  const remainder = MINUTES_PER_DAY - each * cycle.length;
  return { lengths: cycle.map((_, i) => (i === 0 ? each + remainder : each)), each };
}

/**
 * How to lay clashing shifts out cleanly: keep the cycle's start and running
 * order, place each directly after the last. Null when nothing needs fixing.
 */
export function planSmartAdjust<T extends CycleShift & { id: number }>(shifts: T[]): SmartAdjustPlan | null {
  if (!shifts.length || !validateShiftCycle(shifts).length) return null;
  const cycle = orderedCycle(shifts);
  const total = cycle.reduce((sum, s) => sum + s.durationMinutes, 0);
  const sameLength = cycle.every((s) => s.durationMinutes === cycle[0].durationMinutes);
  const { lengths, each } = plannedLengths(cycle, total);
  const shortened = total > MINUTES_PER_DAY;

  let cursor = cycle[0].startMinute;
  const planned = cycle.map((s, i) => {
    const p = { id: s.id, name: s.name, startMinute: mod(cursor, MINUTES_PER_DAY), durationMinutes: lengths[i] };
    cursor += lengths[i];
    return p;
  });
  return {
    shifts: planned,
    confidence: !shortened && sameLength ? 'exact' : 'needsReview',
    shortened,
    unevenLengths: !sameLength,
    totalMinutes: total,
    coveredMinutes: shortened ? MINUTES_PER_DAY : total,
    eachMinutes: each,
  };
}

/** Why a plan needs checking, in English, for logs and tests. */
export function smartAdjustNotes(plan: SmartAdjustPlan): string[] {
  if (plan.shortened) {
    return [`These shifts added up to ${hours(plan.totalMinutes)}, which is more than a day, so their lengths were shortened.`];
  }
  const unassigned = MINUTES_PER_DAY - plan.coveredMinutes;
  return [
    ...(plan.unevenLengths
      ? ['These shifts are different lengths, so the day is not split evenly. Check each one reads the way you expect.']
      : []),
    ...(unassigned > 0
      ? [`They cover ${hours(plan.coveredMinutes)} of the day, leaving ${hours(unassigned)} unassigned.`]
      : []),
  ];
}

function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
