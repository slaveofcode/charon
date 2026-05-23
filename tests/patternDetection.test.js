import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  detectUniformAmounts,
  detectSequentialPattern,
  botPatternScore,
} from '../src/analysis/patternDetection.js';

/**
 * Helper: build a holder record quickly.
 */
function h(rank, amount, address = undefined) {
  return {
    address: address ?? `wallet_${rank}`,
    rank,
    amount,
    percent: null,
    tags: [],
  };
}

describe('detectUniformAmounts', () => {
  it('returns no pattern for mixed amounts', () => {
    const holders = [
      h(1, 100_000),
      h(2, 200_000),
      h(3, 150_000),
      h(4, 50_000),
      h(5, 75_000),
      h(6, 320_000),
      h(7, 110_000),
      h(8, 89_000),
      h(9, 410_000),
      h(10, 99_500),
    ];
    const result = detectUniformAmounts(holders);
    assert.strictEqual(result.uniformGroupSize, 1); // no group > 1
    assert.strictEqual(result.uniformGroupPct, 10); // 1/10
    assert.strictEqual(result.flagged, false);
    assert.deepStrictEqual(result.uniformAmounts, []);
  });

  it('flags 5 out of 10 holders with the same amount', () => {
    const holders = [
      h(1, 500_000),
      h(2, 500_000),
      h(3, 500_000),
      h(4, 500_000),
      h(5, 500_000),
      h(6, 123_456),
      h(7, 789_012),
      h(8, 888_888),
      h(9, 999_999),
      h(10, 111_111),
    ];
    const result = detectUniformAmounts(holders);
    // 5 holders with exact same amount => all merge into one group
    assert.strictEqual(result.uniformGroupSize, 5);
    assert.strictEqual(result.uniformGroupPct, 50);
    assert.strictEqual(result.flagged, true);
    assert.ok(result.uniformAmounts.includes(500_000));
  });

  it('handles amounts within tolerance (0.1%) as uniform', () => {
    // 1000000 * 1.001 = 1001000, so anything within 0.1% is grouped
    const holders = [
      h(1, 1_000_000),
      h(2, 1_000_500),  // 0.05% diff
      h(3, 1_001_000),  // ~0.1% diff from 1M
      h(4, 999_000),    // 0.1% diff
      h(5, 2_000_000),  // way off
    ];
    const result = detectUniformAmounts(holders, 0.001);
    assert.strictEqual(result.uniformGroupSize, 4);
    assert.strictEqual(result.flagged, true);
    assert.strictEqual(result.uniformGroupPct, 80);
  });

  it('returns size=1 for a single holder (no pattern)', () => {
    const holders = [h(1, 500_000)];
    const result = detectUniformAmounts(holders);
    assert.strictEqual(result.uniformGroupSize, 1);
    assert.strictEqual(result.uniformGroupPct, 100); // 1/1 = 100%, but size=1 so not flagged
    assert.strictEqual(result.flagged, false);
    assert.deepStrictEqual(result.uniformAmounts, []);
  });

  it('handles empty holder list gracefully', () => {
    const result = detectUniformAmounts([]);
    assert.strictEqual(result.uniformGroupSize, 0);
    assert.strictEqual(result.uniformGroupPct, 0);
    assert.strictEqual(result.flagged, false);
    assert.deepStrictEqual(result.uniformAmounts, []);
  });

  it('handles holders with zero amounts gracefully', () => {
    const holders = [
      h(1, 0),
      h(2, 0),
      h(3, 0),
      h(4, 100_000),
    ];
    const result = detectUniformAmounts(holders);
    // Zeros get skipped during grouping, so each zero ends up as its own group
    assert.strictEqual(result.uniformGroupSize, 1); // all zeros isolated
    assert.strictEqual(result.flagged, false);
  });
});

describe('detectSequentialPattern', () => {
  it('detects consecutive ranks among uniform holders', () => {
    const holders = [
      h(1, 500_000),
      h(2, 500_000),
      h(3, 500_000),
      h(4, 500_000),
      h(5, 500_000),
      h(6, 999_999),
      h(7, 888_888),
    ];
    const result = detectSequentialPattern(holders);
    // 5 holders with same amount at ranks 1-5 → consecutive streak of 5
    assert.strictEqual(result.sequentialGroupSize, 5);
    assert.strictEqual(result.sequentialGroupPct, (5 / 7) * 100);
    assert.strictEqual(result.flagged, true);
  });

  it('does not flag non-consecutive ranks even with same amount', () => {
    const holders = [
      h(1, 500_000),
      h(3, 500_000),  // skip rank 2
      h(5, 500_000),  // skip rank 4
      h(7, 500_000),
    ];
    const result = detectSequentialPattern(holders);
    // Each uniform amount group has at most 2 consecutive? Actually ranks 1,3,5,7 —
    // within the uniform group [1,3,5,7], sorted by rank: 1,3,5,7 — none are consecutive.
    // Longest streak = 1.
    assert.strictEqual(result.sequentialGroupSize, 1);
    assert.strictEqual(result.flagged, false);
  });

  it('returns no pattern for single holder', () => {
    const holders = [h(1, 500_000)];
    const result = detectSequentialPattern(holders);
    assert.strictEqual(result.sequentialGroupSize, 0);
    assert.strictEqual(result.sequentialGroupPct, 0);
    assert.strictEqual(result.flagged, false);
  });

  it('handles empty holder list gracefully', () => {
    const result = detectSequentialPattern([]);
    assert.strictEqual(result.sequentialGroupSize, 0);
    assert.strictEqual(result.sequentialGroupPct, 0);
    assert.strictEqual(result.flagged, false);
  });
});

describe('botPatternScore', () => {
  it('combines uniform and sequential scores correctly', () => {
    // 5/10 uniform at same amount, ranks 1-5 consecutive
    const holders = [
      h(1, 500_000),
      h(2, 500_000),
      h(3, 500_000),
      h(4, 500_000),
      h(5, 500_000),
      h(6, 100_000),
      h(7, 200_000),
      h(8, 300_000),
      h(9, 400_000),
      h(10, 50_000),
    ];
    const result = botPatternScore(holders);

    assert.strictEqual(result.uniform.uniformGroupSize, 5);
    assert.strictEqual(result.uniform.uniformGroupPct, 50);
    assert.strictEqual(result.uniform.flagged, true);

    assert.strictEqual(result.sequential.sequentialGroupSize, 5);
    assert.strictEqual(result.sequential.sequentialGroupPct, 50);
    assert.strictEqual(result.sequential.flagged, true);

    // combined = (50 + 50) / 2 = 50
    assert.strictEqual(result.combinedScore, 50);
    assert.strictEqual(result.flagged, true);
  });

  it('returns low score for clean holder distribution', () => {
    const holders = [
      h(1, 1000),
      h(2, 2000),
      h(3, 3000),
      h(4, 4000),
      h(5, 5000),
      h(6, 6000),
      h(7, 7000),
      h(8, 8000),
      h(9, 9000),
      h(10, 10_000),
    ];
    const result = botPatternScore(holders);
    // No uniform groups (amounts are spaced far apart) → uniformGroupSize=1
    assert.strictEqual(result.combinedScore < 40, true);
    assert.strictEqual(result.flagged, false);
  });

  it('handles empty holder list gracefully', () => {
    const result = botPatternScore([]);
    assert.strictEqual(result.combinedScore, 0);
    assert.strictEqual(result.flagged, false);
    assert.strictEqual(result.uniform.uniformGroupSize, 0);
    assert.strictEqual(result.sequential.sequentialGroupSize, 0);
  });
});
