// Ported case by case from packages/sf_core/test/bonus_calculator_test.dart.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AttendanceStatus, BonusRule, BonusSlab } from '@stitchflow/contract';
import {
  bonusExplanation, calculateEntryBonus, earnsNoLeaveBonus, slabProblemMessage, validateSlabs,
  type BonusInput,
} from '../src/domain/bonus.ts';

function rule(over: Partial<BonusRule> = {}, slabs: BonusSlab[] = []): BonusRule {
  return {
    id: 1, name: 'Full head', isActive: true, condition: 'fullHead', kind: 'perThousandSlab',
    flatAmount: 0, ratePerFrame: 0, sortOrder: 0, slabs, ...over,
  };
}

const slab = (from: number, to: number | null, value: number, id = 1): BonusSlab =>
  ({ id, fromStitches: from, toStitches: to, value });

/** The seeded ladder: 1.0 under 100k, 1.5 to 200k, 2.0 above. */
const ladder = () => [slab(0, 100000, 1.0, 1), slab(100000, 200000, 1.5, 2), slab(200000, null, 2.0, 3)];

const input = (over: Partial<BonusInput> = {}): BonusInput =>
  ({ stitches: 0, frames: 0, hasHeadLoss: false, isStitchBased: false, ...over });

describe('per-1000 slabs', () => {
  const run = (stitches: number) => calculateEntryBonus(input({ stitches }), [rule({}, ladder())]);

  it('the matched slab sets the rate for the whole count', () => {
    assert.equal(run(180000).amount, 270, '180k x 1.5');
    assert.equal(run(50000).amount, 50, '50k x 1.0');
    assert.equal(run(300000).amount, 600, '300k x 2.0');
  });

  it('a slab boundary belongs to the upper band', () => {
    assert.equal(run(100000).amount, 150, '100k x 1.5, not x 1.0');
    assert.equal(run(99999).amount, 100, 'just under the boundary, so still x 1.0');
  });

  it('the open-ended top band has no ceiling', () => {
    assert.equal(run(5000000).amount, 10000);
  });

  it('zero stitches earn nothing but still match a slab', () => {
    const r = run(0);
    assert.equal(r.amount, 0);
    assert.notEqual(r.slab, null);
  });

  it('the result explains itself', () => {
    assert.match(bonusExplanation(run(180000)), /180k/);
    assert.match(bonusExplanation(run(180000)), /1\.5/);
  });
});

describe('fixed slabs', () => {
  const run = (stitches: number) => calculateEntryBonus(input({ stitches }), [
    rule({ kind: 'fixedSlab' }, [slab(0, 100000, 100, 1), slab(100000, 200000, 250, 2), slab(200000, null, 500, 3)]),
  ]);

  it('pays the band amount outright, whatever the exact count', () => {
    assert.equal(run(120000).amount, 250);
    assert.equal(run(199999).amount, 250);
    assert.equal(run(200000).amount, 500);
  });
});

describe('flat + slabs', () => {
  it('adds the flat amount to the slab component', () => {
    const r = calculateEntryBonus(input({ stitches: 180000 }),
      [rule({ kind: 'flatPlusSlab', flatAmount: 100 }, ladder())]);
    assert.equal(r.amount, 370, '100 flat + 180k x 1.5');
  });

  it('the flat amount still pays when no slab matches', () => {
    const r = calculateEntryBonus(input({ stitches: 500 }),
      // Ladder starts above this shift's count.
      [rule({ kind: 'flatPlusSlab', flatAmount: 100 }, [slab(100000, null, 2.0)])]);
    assert.equal(r.amount, 100);
  });
});

describe('per frame', () => {
  it('pays on frames and ignores stitches', () => {
    const r = calculateEntryBonus(input({ stitches: 999999, frames: 12 }),
      [rule({ kind: 'perFrame', ratePerFrame: 25 })]);
    assert.equal(r.amount, 300);
    assert.match(bonusExplanation(r), /12 frames/);
  });

  it('one frame reads as singular', () => {
    const r = calculateEntryBonus(input({ frames: 1 }), [rule({ kind: 'perFrame', ratePerFrame: 25 })]);
    assert.match(bonusExplanation(r), /1 frame /);
  });
});

describe('choosing a rule', () => {
  const fullHead = rule({ id: 1, name: 'Full head', condition: 'fullHead' }, ladder());
  const headLoss = rule({ id: 2, name: 'Head loss', condition: 'headLoss', kind: 'fixedSlab' }, [slab(0, null, 80)]);

  it('an untouched entry is paid by the full-head rule', () => {
    const r = calculateEntryBonus(input({ stitches: 180000 }), [fullHead, headLoss]);
    assert.equal(r.rule?.name, 'Full head');
    assert.equal(r.amount, 270);
  });

  it('ticking head loss switches which rule pays', () => {
    const r = calculateEntryBonus(input({ stitches: 180000, hasHeadLoss: true }), [fullHead, headLoss]);
    assert.equal(r.rule?.name, 'Head loss');
    assert.equal(r.amount, 80);
  });

  it('an inactive rule does not pay', () => {
    const r = calculateEntryBonus(input({ stitches: 180000 }), [rule({ isActive: false }, ladder())]);
    assert.equal(r.amount, 0);
    assert.equal(r.rule, null);
  });

  it('no matching condition pays nothing, with a reason', () => {
    const r = calculateEntryBonus(input({ stitches: 180000, hasHeadLoss: true }), [fullHead]);
    assert.equal(r.amount, 0);
    assert.match(bonusExplanation(r), /head loss/);
  });

  it('sort order breaks a tie between two matching rules', () => {
    const second = rule({ id: 9, name: 'Second', sortOrder: 1, kind: 'fixedSlab' }, [slab(0, null, 999)]);
    const first = rule({ id: 8, name: 'First', sortOrder: 0 }, ladder());
    // Deliberately passed lowest-priority first.
    const r = calculateEntryBonus(input({ stitches: 180000 }), [second, first]);
    assert.equal(r.rule?.name, 'First');
  });

  it('no rules at all pays nothing', () => {
    assert.equal(calculateEntryBonus(input({ stitches: 1 }), []).amount, 0);
  });
});

describe('stitch based second machine', () => {
  const stitchBased = input({ stitches: 180000, isStitchBased: true });

  it('pays the settings rate in place of any rule', () => {
    const r = calculateEntryBonus(stitchBased, [rule({}, ladder())],
      { stitchBasedEnabled: true, stitchBasedRatePerThousand: 0.8 });
    assert.equal(r.amount, 144, '180k x 0.8, not the 270 the rule would pay');
    assert.equal(r.fromStitchBased, true);
    assert.equal(r.rule, null);
  });

  it('says so when the tick is on but no rate is configured', () => {
    const r = calculateEntryBonus(stitchBased, [rule({}, ladder())],
      { stitchBasedEnabled: true, stitchBasedRatePerThousand: 0 });
    assert.equal(r.amount, 0);
    assert.match(bonusExplanation(r), /no rate is set/);
  });

  it('the tick is inert while the setting is off', () => {
    const r = calculateEntryBonus(stitchBased, [rule({}, ladder())],
      { stitchBasedEnabled: false, stitchBasedRatePerThousand: 0.8 });
    assert.equal(r.amount, 0);
  });
});

describe('no leave bonus', () => {
  const month = (statuses: (AttendanceStatus | null)[]) => statuses.map((status) => ({ status }));
  const fullMonth = () => Array<AttendanceStatus | null>(30).fill('present');

  it('a full month of present days earns it', () => {
    assert.equal(earnsNoLeaveBonus(month(fullMonth())), true);
  });

  it('one absence breaks it', () => {
    const days = fullMonth();
    days[14] = 'absent';
    assert.equal(earnsNoLeaveBonus(month(days)), false);
  });

  it('a half day breaks it', () => {
    const days = fullMonth();
    days[3] = 'halfDay';
    assert.equal(earnsNoLeaveBonus(month(days)), false);
  });

  it('an unmarked date breaks it', () => {
    const days = fullMonth();
    days[29] = null;
    assert.equal(earnsNoLeaveBonus(month(days)), false);
  });

  it('an empty month earns nothing', () => {
    assert.equal(earnsNoLeaveBonus([]), false);
  });
});

describe('validateSlabs', () => {
  it('a sound ladder has no complaints', () => {
    assert.deepEqual(validateSlabs(ladder()), []);
  });

  it('an empty ladder is called out', () => {
    assert.deepEqual(validateSlabs([]).map((p) => p.kind), ['empty']);
  });

  it('overlapping bands are reported', () => {
    const problems = validateSlabs([slab(0, 150000, 1.0, 1), slab(100000, null, 2.0, 2)]);
    assert.equal(problems.length, 1);
    assert.match(slabProblemMessage(problems[0]), /overlap/);
    assert.deepEqual(problems[0], {
      kind: 'overlap', fromStitches: 0, toStitches: 150000, nextFromStitches: 100000, nextToStitches: null,
    });
  });

  it('a gap between bands is reported', () => {
    const problems = validateSlabs([slab(0, 100000, 1.0, 1), slab(120000, null, 2.0, 2)]);
    assert.equal(problems.length, 1);
    assert.match(slabProblemMessage(problems[0]), /Nothing covers/);
    assert.equal(slabProblemMessage(problems[0]), 'Nothing covers 100k–120k.');
  });

  it('an inverted band is reported', () => {
    const problems = validateSlabs([slab(100000, 50000, 1.0)]);
    assert.equal(problems.length, 1);
    assert.match(slabProblemMessage(problems[0]), /above the bottom/);
  });

  it('an open band in the middle is reported', () => {
    const problems = validateSlabs([slab(0, null, 1.0, 1), slab(100000, null, 2.0, 2)]);
    assert.match(slabProblemMessage(problems[0]), /open-ended/);
  });
});

// The Dart BonusInput test pins value equality, which a provider cache relied
// on. A plain object has no identity to get wrong; what carries over is that
// equal inputs give equal results.
describe('BonusInput', () => {
  it('equal inputs give equal results', () => {
    const rules = [rule({}, ladder())];
    assert.deepEqual(
      calculateEntryBonus(input({ stitches: 1000, frames: 2 }), rules),
      calculateEntryBonus(input({ stitches: 1000, frames: 2 }), rules),
    );
  });
});
