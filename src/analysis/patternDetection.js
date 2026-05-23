/**
 * Detect bot-like patterns in token holder data.
 *
 * Uniform amounts analysis — identifies groups of holders holding suspiciously
 * similar token amounts, a common bundler/sybil pattern.
 *
 * Sequential buying pattern analysis — checks if uniform-amount holders appear
 * at consecutive ranks, suggesting automated sequential distribution.
 *
 * Combined botPatternScore — averages uniform and sequential scores into a
 * single 0-100 risk score.
 *
 * All logic is deterministic and requires no RPC calls.
 *
 * Holder data structure:
 *   { address: string, rank: number, amount: number, percent: number | null, tags: string[] }
 */

/**
 * Group holders whose raw amounts are within `tolerance` (as a fraction) of
 * each other. Returns the largest uniform-amount group.
 *
 * @param {{ address: string, rank: number, amount: number }[]} holders
 * @param {number} [amountTolerance=0.001] — 0.001 = 0.1 % relative difference
 * @returns {{ uniformGroupSize: number, uniformGroupPct: number, uniformAmounts: number[], flagged: boolean }}
 */
export function detectUniformAmounts(holders, amountTolerance = 0.001) {
  if (!Array.isArray(holders) || holders.length === 0) {
    return {
      uniformGroupSize: 0,
      uniformGroupPct: 0,
      uniformAmounts: [],
      flagged: false,
    };
  }

  // Sort by amount ascending so adjacent amounts are close
  const sorted = [...holders]
    .map(h => ({ ...h, amount: Number(h.amount) || 0 }))
    .sort((a, b) => a.amount - b.amount);

  // Walk through sorted amounts; group items whose relative difference ≤ tolerance
  let bestGroupSize = 1;
  let bestGroupAmounts = [sorted[0].amount];

  let currentGroup = [sorted[0]];
  let currentGroupAmountSet = new Set([sorted[0].amount]);

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];

    // Skip zero amounts — they tell us nothing about uniform buying
    if (curr.amount === 0 && prev.amount === 0) {
      continue;
    }

    const denom = Math.max(prev.amount, curr.amount);
    const relDiff = denom > 0 ? Math.abs(curr.amount - prev.amount) / denom : 0;

    if (relDiff <= amountTolerance) {
      currentGroup.push(curr);
      currentGroupAmountSet.add(curr.amount);
    } else {
      // Re-evaluate best group
      if (currentGroup.length > bestGroupSize) {
        bestGroupSize = currentGroup.length;
        bestGroupAmounts = [...currentGroupAmountSet];
      }
      // Start new group
      currentGroup = [curr];
      currentGroupAmountSet = new Set([curr.amount]);
    }
  }

  // Final check
  if (currentGroup.length > bestGroupSize) {
    bestGroupSize = currentGroup.length;
    bestGroupAmounts = [...currentGroupAmountSet];
  }

  // A group of size 1 is not a pattern
  const hasPattern = bestGroupSize > 1;
  const groupSize = hasPattern ? bestGroupSize : 1;
  const uniformGroupPct = holders.length > 0
    ? (groupSize / holders.length) * 100
    : 0;

  return {
    uniformGroupSize: groupSize,
    uniformGroupPct,
    uniformAmounts: hasPattern ? bestGroupAmounts.sort((a, b) => a - b) : [],
    flagged: hasPattern && uniformGroupPct >= 40,
  };
}

/**
 * Among holders whose amounts fall within tolerance of each other (uniform
 * groups), check whether the members of each uniform group hold consecutive
 * ranks.
 *
 * Returns the largest consecutive-rank uniform group.
 *
 * @param {{ address: string, rank: number, amount: number }[]} holders
 * @returns {{ sequentialGroupSize: number, sequentialGroupPct: number, flagged: boolean }}
 */
export function detectSequentialPattern(holders) {
  if (!Array.isArray(holders) || holders.length === 0) {
    return {
      sequentialGroupSize: 0,
      sequentialGroupPct: 0,
      flagged: false,
    };
  }

  // Group holders by uniform amounts (reuse grouping logic from detectUniformAmounts)
  const sorted = [...holders]
    .map(h => ({ ...h, amount: Number(h.amount) || 0 }))
    .sort((a, b) => a.amount - b.amount);

  const uniformGroups = [];
  let currentGroup = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];

    if (curr.amount === 0 && prev.amount === 0) {
      continue;
    }

    const denom = Math.max(prev.amount, curr.amount);
    const relDiff = denom > 0 ? Math.abs(curr.amount - prev.amount) / denom : 0;

    if (relDiff <= 0.001) {
      currentGroup.push(curr);
    } else {
      if (currentGroup.length > 1) uniformGroups.push(currentGroup);
      currentGroup = [curr];
    }
  }
  if (currentGroup.length > 1) uniformGroups.push(currentGroup);

  // For each uniform group, check if ranks are consecutive
  let bestSize = 0;

  for (const group of uniformGroups) {
    group.sort((a, b) => a.rank - b.rank);

    // Find the longest streak of consecutive ranks within this group
    let streak = 1;
    let maxStreak = 1;

    for (let i = 1; i < group.length; i++) {
      if (group[i].rank === group[i - 1].rank + 1) {
        streak++;
        if (streak > maxStreak) maxStreak = streak;
      } else {
        streak = 1;
      }
    }

    if (maxStreak > bestSize) bestSize = maxStreak;
  }

  const sequentialGroupPct = holders.length > 0
    ? (bestSize / holders.length) * 100
    : 0;

  return {
    sequentialGroupSize: bestSize,
    sequentialGroupPct,
    flagged: sequentialGroupPct >= 40,
  };
}

/**
 * Combined bot-pattern risk score.
 *
 * @param {{ address: string, rank: number, amount: number }[]} holders
 * @returns {{ uniform: object, sequential: object, combinedScore: number, flagged: boolean }}
 */
export function botPatternScore(holders) {
  const uniform = detectUniformAmounts(holders);
  const sequential = detectSequentialPattern(holders);

  const combinedScore = holders.length > 0
    ? (uniform.uniformGroupPct + sequential.sequentialGroupPct) / 2
    : 0;

  return {
    uniform,
    sequential,
    combinedScore,
    flagged: combinedScore >= 40,
  };
}
