// Bonus rules, ported from packages/sf_core/lib/src/domain/bonus_calculator.dart
// in the apps repo. Pure functions: no database.
//
// The figure is the whole machine's for one shift; payroll splits it between
// the operators who ran it.

import { roundMoney } from '@stitchflow/contract';
import type {
  AttendanceStatus, BonusCondition, BonusKind, BonusRule, BonusSlab, SlabProblem,
} from '@stitchflow/contract';

/** What the engine needs to know about one shift. */
export interface BonusInput {
  stitches: number;
  frames: number;
  hasHeadLoss: boolean;
  isStitchBased: boolean;
}

export interface StitchBasedSettings {
  stitchBasedEnabled: boolean;
  stitchBasedRatePerThousand: number;
}

/** Why the engine paid what it did: the figures, not a sentence. */
export type BonusReason =
  | { type: 'noMatchingRule'; condition: BonusCondition | null }
  | { type: 'stitchBasedWithoutRate' }
  | { type: 'stitchBasedPaid'; thousands: number; rate: number }
  | { type: 'perFramePaid'; ruleName: string; frames: number; rate: number }
  | { type: 'outsideEverySlab'; ruleName: string; thousands: number }
  | { type: 'slabPaid'; ruleName: string; kind: BonusKind; thousands: number; slab: BonusSlab; flatAmount: number };

export interface BonusResult {
  amount: number;
  rule: BonusRule | null;
  slab: BonusSlab | null;
  reason: BonusReason;
  /** True when the second-machine rate paid instead of a rule. */
  fromStitchBased: boolean;
}

export const conditionOf = (input: Pick<BonusInput, 'hasHeadLoss'>): BonusCondition =>
  input.hasHeadLoss ? 'headLoss' : 'fullHead';

const result = (amount: number, reason: BonusReason, more: Partial<BonusResult> = {}): BonusResult =>
  ({ amount, rule: null, slab: null, reason, fromStitchBased: false, ...more });

/**
 * Works out the bonus one production entry earns.
 *
 * 1. A second-machine ("stitch based") entry is paid at the per-1,000 rate
 *    from settings, in place of any rule.
 * 2. Otherwise the first active rule whose condition matches the shift pays,
 *    by sort order (then id, the order the rules are listed in).
 * 3. Failing both, nothing.
 */
export function calculateEntryBonus(
  input: BonusInput,
  rules: BonusRule[],
  settings: StitchBasedSettings = { stitchBasedEnabled: false, stitchBasedRatePerThousand: 0 },
): BonusResult {
  const thousands = input.stitches / 1000;

  if (input.isStitchBased) {
    const rate = settings.stitchBasedRatePerThousand;
    if (!settings.stitchBasedEnabled || rate <= 0) {
      return result(0, { type: 'stitchBasedWithoutRate' }, { fromStitchBased: true });
    }
    return result(roundMoney(thousands * rate), { type: 'stitchBasedPaid', thousands, rate }, { fromStitchBased: true });
  }

  const condition = conditionOf(input);
  const rule = rules
    .filter((r) => r.isActive && r.condition === condition)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)[0];
  if (!rule) return result(0, { type: 'noMatchingRule', condition });

  if (rule.kind === 'perFrame') {
    return result(roundMoney(input.frames * rule.ratePerFrame), {
      type: 'perFramePaid', ruleName: rule.name, frames: input.frames, rate: rule.ratePerFrame,
    }, { rule });
  }

  const slab = slabFor(rule.slabs, input.stitches);
  if (!slab) {
    // The flat part of flat + slab still pays when the count misses every band.
    const amount = rule.kind === 'flatPlusSlab' ? roundMoney(rule.flatAmount) : 0;
    return result(amount, { type: 'outsideEverySlab', ruleName: rule.name, thousands }, { rule });
  }
  const amount = rule.kind === 'fixedSlab' ? slab.value
    : rule.kind === 'perThousandSlab' ? thousands * slab.value
    : rule.flatAmount + thousands * slab.value;
  return result(roundMoney(amount), {
    type: 'slabPaid', ruleName: rule.name, kind: rule.kind, thousands, slab, flatAmount: rule.flatAmount,
  }, { rule, slab });
}

const byFrom = <T extends { fromStitches: number }>(slabs: T[]): T[] =>
  [...slabs].sort((a, b) => a.fromStitches - b.fromStitches);

/** The band a stitch count lands in, or null when the ladder does not cover it. */
function slabFor(slabs: BonusSlab[], stitches: number): BonusSlab | null {
  return byFrom(slabs).find((s) =>
    stitches >= s.fromStitches && (s.toStitches === null || stitches < s.toStitches)) ?? null;
}

/** A band as the floor says it: "100k–200k", or "200k+" for the top one. */
export function stitchRangeLabel(from: number, to: number | null): string {
  const low = `${Math.round(from / 1000)}k`;
  return to === null ? `${low}+` : `${low}–${Math.round(to / 1000)}k`;
}

/** A rate or a count of thousands, without a trailing ".00". */
export const formatBonusFigure = (v: number): string =>
  Number.isInteger(v) ? String(v) : v.toFixed(2);

const CONDITION_LABEL: Record<BonusCondition, string> = { fullHead: 'Full head', headLoss: 'Head loss' };

/** The reason in English, for logs and tests; the apps word it themselves. */
export function bonusExplanation(r: BonusResult): string {
  const f = formatBonusFigure;
  const reason = r.reason;
  switch (reason.type) {
    case 'noMatchingRule':
      return reason.condition === null
        ? 'No bonus rule matches this shift.'
        : `No active ${CONDITION_LABEL[reason.condition].toLowerCase()} rule to pay this shift.`;
    case 'stitchBasedWithoutRate':
      return 'Stitch based is ticked, but no rate is set in Settings.';
    case 'stitchBasedPaid':
      return `Stitch based · ${f(reason.thousands)}k × ${f(reason.rate)} per 1,000.`;
    case 'perFramePaid':
      return `${reason.ruleName} · ${reason.frames} frame${reason.frames === 1 ? '' : 's'} × ${f(reason.rate)}.`;
    case 'outsideEverySlab':
      return `${reason.ruleName} · ${f(reason.thousands)}k stitches falls outside every slab.`;
    case 'slabPaid': {
      const { slab, thousands } = reason;
      const range = stitchRangeLabel(slab.fromStitches, slab.toStitches);
      const how = reason.kind === 'fixedSlab' ? `flat ${f(slab.value)} for the ${range} slab.`
        : reason.kind === 'flatPlusSlab'
          ? `${f(reason.flatAmount)} flat + ${f(thousands)}k × ${f(slab.value)} per 1,000.`
          : `${f(thousands)}k × ${f(slab.value)} per 1,000 (${range} slab).`;
      return `${reason.ruleName} · ${how}`;
    }
  }
}

/**
 * Whether a month earns the no-leave bonus: every date of the calendar month
 * a full present day. A half day, an absence or an unmarked date breaks it.
 */
export function earnsNoLeaveBonus(monthDays: { status: AttendanceStatus | null }[]): boolean {
  return monthDays.length > 0 && monthDays.every((d) => d.status === 'present');
}

/** One band of a ladder, saved or not. */
export interface Band {
  fromStitches: number;
  toStitches: number | null;
}

const problem = (kind: SlabProblem['kind'], slab?: Band, next?: Band): SlabProblem => ({
  kind,
  fromStitches: slab?.fromStitches ?? null,
  toStitches: slab?.toStitches ?? null,
  nextFromStitches: next?.fromStitches ?? null,
  nextToStitches: next?.toStitches ?? null,
});

/** Gaps, overlaps and malformed bands in a rule's ladder; empty when it is sound. */
export function validateSlabs(slabs: Band[]): SlabProblem[] {
  if (!slabs.length) return [problem('empty')];
  const ordered = byFrom(slabs);
  const problems: SlabProblem[] = [];
  ordered.forEach((slab, i) => {
    if (slab.toStitches !== null && slab.toStitches <= slab.fromStitches) {
      problems.push(problem('inverted', slab));
      return;
    }
    const next = ordered[i + 1];
    if (!next) return;
    if (slab.toStitches === null) problems.push(problem('openEndedNotLast', slab));
    else if (slab.toStitches > next.fromStitches) problems.push(problem('overlap', slab, next));
    else if (slab.toStitches < next.fromStitches) problems.push(problem('gap', slab, next));
  });
  return problems;
}

/** A problem in English, for logs and tests; the rule editor words it. */
export function slabProblemMessage(p: SlabProblem): string {
  const band = stitchRangeLabel(p.fromStitches ?? 0, p.toStitches);
  switch (p.kind) {
    case 'empty':
      return 'Add at least one slab.';
    case 'inverted':
      return `${band}: the top must be above the bottom.`;
    case 'openEndedNotLast':
      return `${band} is open-ended but is not the last slab.`;
    case 'overlap':
      return `${band} and ${stitchRangeLabel(p.nextFromStitches ?? 0, p.nextToStitches)} overlap.`;
    case 'gap':
      return `Nothing covers ${stitchRangeLabel(p.toStitches ?? 0, p.nextFromStitches)}.`;
  }
}
