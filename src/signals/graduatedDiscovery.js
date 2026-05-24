// ─── Discovery signal source: GMGN graduated/bonded tokens ──────────────
// Polls GMGN /v1/market/rank for graduated tokens (meteora, pool_pump_amm)
// and injects qualifying dip candidates into the candidate pipeline.
// Complements gmgnDiscovery.js which only handles pump.fun tokens.
// Complementary strategy: signal server handles fee_claim + trending signals.

import { boolSetting, numSetting } from '../db/settings.js';
import { fetchGmgnTrendingRows, trendingSignalPass, storeSignalEvent } from './trending.js';
import { processCandidateFromSignals } from '../pipeline/orchestrator.js';

const POLL_MS = 5 * 60 * 1000; // 5 minutes

let discoveryTimer = null;

/**
 * Start the graduated discovery polling loop.
 * Call once during app startup (server mode).
 */
export function startGraduatedDiscovery() {
  if (discoveryTimer) {
    console.log('[graduated-discovery] already running');
    return;
  }

  const run = async () => {
    if (!boolSetting('graduated_discovery_enabled', true)) return;

    const interval = '6h'; // graduated tokens need longer window
    const limit = Math.max(1, Math.min(200, Math.floor(numSetting('graduated_discovery_limit', 100))));

    try {
      const rows = await fetchGmgnTrendingRows(interval, Math.min(100, limit));
      let tracked = 0;

      for (const row of rows) {
        const mint = row?.address || row?.mint;
        if (!mint) continue;

        // Skip pump.fun tokens — this source is for graduated/bonded tokens only
        if (String(mint).endsWith('pump')) continue;

        // Apply quality filters (rug_ratio, bundler_rate, wash_trading, volume, swaps)
        if (!trendingSignalPass(row)) continue;

        storeSignalEvent(mint, 'graduated_discovery', 'gmgn_graduated', row);
        await processCandidateFromSignals({
          mint,
          route: 'graduated_discovery',
          trendingToken: row,
        });
        tracked += 1;
      }

      if (tracked > 0) {
        console.log(`[graduated-discovery] loaded ${rows.length}, injected ${tracked} graduated tokens`);
      } else if (rows.length > 0) {
        console.log(`[graduated-discovery] loaded ${rows.length} rows, 0 tokens passed filter`);
      }
    } catch (err) {
      console.log(`[graduated-discovery] error: ${err.message || err}`);
    }
  };

  // Do first run immediately, then schedule
  run().catch(err => console.log(`[graduated-discovery] initial run failed: ${err.message}`));
  discoveryTimer = setInterval(() => run().catch(err => console.log(`[graduated-discovery] ${err.message}`)), POLL_MS);

  console.log('[graduated-discovery] started (poll every 300s, interval=6h for graduated/bonded tokens)');
}

/**
 * Stop the graduated discovery polling loop.
 */
export function stopGraduatedDiscovery() {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
    console.log('[graduated-discovery] stopped');
  }
}
