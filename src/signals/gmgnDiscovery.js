import { boolSetting, numSetting, setting } from '../db/settings.js';
import { fetchGmgnTrendingRows, trendingSignalPass, storeSignalEvent } from './trending.js';
import { processCandidateFromSignals } from '../pipeline/orchestrator.js';

// ─── Discovery signal source: GMGN market rank ────────────────────────────
// Polls GMGN /v1/market/rank for trending tokens and injects qualifying
// pump.fun tokens into Charon's candidate pipeline.
// This runs alongside signal server polling in server mode.

const POLL_MS = 5 * 60 * 1000; // 5 minutes

let discoveryTimer = null;

/**
 * Start the GMGN discovery polling loop.
 * Call once during app startup (server mode).
 */
export function startGmgnDiscovery() {
  if (discoveryTimer) {
    console.log('[gmgn-discovery] already running');
    return;
  }

  const run = async () => {
    if (!boolSetting('gmgn_discovery_enabled', true)) return;

    const interval = setting('gmgn_discovery_interval', '5m');
    const limit = Math.max(1, Math.min(200, Math.floor(numSetting('gmgn_discovery_limit', 100))));

    try {
      const rows = await fetchGmgnTrendingRows(interval, Math.min(100, limit));
      let tracked = 0;

      for (const row of rows) {
        const mint = row?.address || row?.mint;
        if (!mint) continue;

        // Only pump.fun tokens — skip graduated / bonded tokens
        if (!String(mint).endsWith('pump')) continue;

        // Apply quality filters (rug_ratio, bundler_rate, wash_trading, volume, swaps)
        if (!trendingSignalPass(row)) continue;

        storeSignalEvent(mint, 'gmgn_discovery', 'gmgn', row);
        await processCandidateFromSignals({
          mint,
          route: 'gmgn_discovery',
          trendingToken: row,
        });
        tracked += 1;
      }

      if (tracked > 0) {
        console.log(`[gmgn-discovery] loaded ${rows.length}, injected ${tracked} pump.fun tokens`);
      } else if (rows.length > 0) {
        console.log(`[gmgn-discovery] loaded ${rows.length} rows, 0 pump.fun tokens passed filter`);
      }
    } catch (err) {
      console.log(`[gmgn-discovery] error: ${err.message || err}`);
    }
  };

  // Do first run immediately, then schedule
  run().catch(err => console.log(`[gmgn-discovery] initial run failed: ${err.message}`));
  discoveryTimer = setInterval(() => run().catch(err => console.log(`[gmgn-discovery] ${err.message}`)), POLL_MS);

  console.log(`[gmgn-discovery] started (poll every ${POLL_MS / 1000}s)`);
}

/**
 * Stop the GMGN discovery polling loop.
 */
export function stopGmgnDiscovery() {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
    console.log('[gmgn-discovery] stopped');
  }
}
