import { walletRiskProfile } from './walletProfile.js';
import { detectClusters } from './clusterDetection.js';
import { botPatternScore } from './patternDetection.js';
import { recordWalletObservation, getProvenWallets } from './walletTracker.js';
import { walletCache } from '../enrichment/rpcCache.js';

/**
 * Run full wallet + bot analysis on a candidate token's top holders.
 * Called from candidateBuilder.js after fetchJupiterHolders.
 *
 * @param {Object} candidate - The candidate object (must have holders.holders array)
 * @returns {Object} analysis result { passed, failures, scores, details }
 */
export async function analyzeWalletLayer(candidate, strat = null) {
  const holders = candidate.holders?.holders || [];
  const mint = candidate.token?.mint;

  // Skip if no holder data
  if (!holders.length) {
    return {
      passed: true,
      warnings: ['No holder data available'],
      scores: {},
      details: {},
    };
  }

  const top10 = holders.slice(0, 10);
  const failures = [];
  const warnings = [];

  // ── Phase 1: Individual wallet risk profiles ──
  let profiles = [];
  try {
    const results = await Promise.allSettled(
      top10.map(h => walletRiskProfile(h.address))
    );
    profiles = results.map((r, i) => ({
      address: top10[i].address,
      holderPct: top10[i].percent,
      rank: top10[i].rank,
      ...(r.status === 'fulfilled' ? r.value : {
        solBalance: null,
        ageMs: null,
        ageHours: null,
        distinctTokens: null,
        isNew: false,
        isDust: false,
        tags: ['error'],
      }),
    }));
  } catch (err) {
    warnings.push(`Wallet profiling failed: ${err.message}`);
  }

  const newWalletPct = profiles.length > 0
    ? profiles.filter(p => p.isNew).length / profiles.length * 100
    : 0;
  const dustWalletPct = profiles.length > 0
    ? profiles.filter(p => p.isDust).length / profiles.length * 100
    : 0;

  // ── Phase 2: Funding cluster detection ──
  let cluster = { clusterFound: false, totalChecked: 0, maxClusterSize: 0, clusterCount: 0, clusters: [], score: 0, level: 'none' };
  try {
    cluster = await detectClusters(holders);
  } catch (err) {
    warnings.push(`Cluster detection failed: ${err.message}`);
  }

  // ── Phase 3: Pattern detection ──
  let patterns = { uniform: { uniformGroupSize: 1, uniformGroupPct: 0, uniformAmounts: [], flagged: false }, sequential: { sequentialGroupSize: 1, sequentialGroupPct: 0, flagged: false }, combinedScore: 0, flagged: false };
  try {
    patterns = botPatternScore(holders);
  } catch (err) {
    warnings.push(`Pattern detection failed: ${err.message}`);
  }

  // ── Phase 4: Check proven smart wallets ──
  let haveSmartWallet = false;
  let provenWalletCount = 0;
  try {
    const proven = getProvenWallets();
    const provenAddresses = proven.map(w => w.address);
    provenWalletCount = profiles.filter(p => provenAddresses.includes(p.address)).length;
    haveSmartWallet = provenWalletCount > 0;
  } catch {
    // Non-critical
  }

  // ── Record observations for tracking (don't await — non-blocking) ──
  if (mint) {
    for (const p of profiles) {
      try {
        recordWalletObservation(p.address, mint, p.holderPct ?? null, null, null, p.tags);
      } catch {
        // Non-critical
      }
    }
  }

  // ── Build filter failures ──
  const maxBotCluster = strat?.max_bot_cluster_size ?? 3;
  const maxNewWallet = strat?.max_new_wallet_pct ?? 50;
  const maxDustWallet = strat?.max_dust_wallet_pct ?? 30;
  const maxUniform = strat?.max_uniform_pct ?? 40;
  const requireSmart = strat?.require_smart_wallet ?? false;

  if (cluster.maxClusterSize >= maxBotCluster) {
    failures.push(`bot_army: ${cluster.maxClusterSize} wallets from same funding source`);
  }
  if (newWalletPct > maxNewWallet) {
    failures.push(`new_wallets: ${newWalletPct.toFixed(0)}% holders < 24h old`);
  }
  if (dustWalletPct > maxDustWallet) {
    failures.push(`dust_wallets: ${dustWalletPct.toFixed(0)}% holders have < 0.01 SOL`);
  }
  if (patterns.flagged) {
    const uniformThreshold = maxUniform;
    if (patterns.uniform.uniformGroupPct >= uniformThreshold) {
      failures.push(`bot_pattern: uniform ${patterns.uniform.uniformGroupPct.toFixed(0)}%`);
    }
  }
  if (requireSmart && !haveSmartWallet) {
    failures.push('no_proven_smart_wallet: no tracked smart wallets among top holders');
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
    scores: {
      newWalletPct: Math.round(newWalletPct),
      dustWalletPct: Math.round(dustWalletPct),
      clusterScore: cluster.score,
      clusterLevel: cluster.level,
      maxClusterSize: cluster.maxClusterSize,
      patternScore: patterns.combinedScore,
      patternFlagged: patterns.flagged,
      uniformPct: patterns.uniform.uniformGroupPct,
      sequentialPct: patterns.sequential.sequentialGroupPct,
      haveSmartWallet,
      provenWalletCount,
    },
    details: {
      cluster,
      patterns,
      profiles: profiles.map(p => ({
        address: p.address.slice(0, 8) + '...',
        solBalance: p.solBalance,
        ageHours: p.ageHours,
        isNew: p.isNew,
        isDust: p.isDust,
        holderPct: p.holderPct,
        tags: p.tags,
      })),
    },
  };
}

/**
 * Clear wallet analysis cache (for testing or cache invalidation).
 */
export function clearAnalysisCache() {
  walletCache.clear();
}
