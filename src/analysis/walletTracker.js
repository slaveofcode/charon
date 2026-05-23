import { now, json } from '../utils.js';
import { db as defaultDb } from '../db/connection.js';

/**
 * Record that a wallet was observed in the top holders of a token at entry time.
 * Creates/updates both wallet_observations and wallet_tracking tables.
 */
export function recordWalletObservation(walletAddress, mint, holderPct, entryPrice, entryMcap, tags = [], dbInstance) {
  const d = dbInstance || defaultDb;
  const ts = now();

  d.prepare(`
    INSERT OR IGNORE INTO wallet_observations
      (wallet_address, mint, observed_at_ms, entry_price, entry_mcap, holder_pct, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(walletAddress, mint, ts, entryPrice ?? null, entryMcap ?? null, holderPct ?? null, json(tags));

  // UPSERT wallet_tracking
  const existing = d.prepare('SELECT * FROM wallet_tracking WHERE address = ?').get(walletAddress);
  if (existing) {
    d.prepare(`
      UPDATE wallet_tracking
      SET total_calls = total_calls + 1, last_seen_ms = ?
      WHERE address = ?
    `).run(ts, walletAddress);
  } else {
    d.prepare(`
      INSERT INTO wallet_tracking (address, first_seen_ms, last_seen_ms, total_calls, tags)
      VALUES (?, ?, ?, 1, ?)
    `).run(walletAddress, ts, ts, json(tags));
  }

  const obs = d.prepare('SELECT id FROM wallet_observations WHERE wallet_address = ? AND mint = ?').get(walletAddress, mint);
  return obs?.id || null;
}

/**
 * Update wallet observation when a position closes.
 * Updates wallet_tracking with PnL data and auto-tags.
 */
export function updateWalletObservationOnClose(positionId, exitPrice, exitMcap, pnlPercent, dbInstance) {
  const d = dbInstance || defaultDb;
  const ts = now();

  const obs = d.prepare("SELECT * FROM wallet_observations WHERE position_id = ?").get(positionId);
  if (!obs) return null;

  const heldDuration = ts - obs.observed_at_ms;

  d.prepare(`
    UPDATE wallet_observations
    SET exit_price = ?, exit_mcap = ?, pnl_percent = ?, held_duration_ms = ?
    WHERE id = ?
  `).run(exitPrice ?? null, exitMcap ?? null, pnlPercent ?? null, heldDuration, obs.id);

  // Update wallet_tracking
  const tracking = d.prepare('SELECT * FROM wallet_tracking WHERE address = ?').get(obs.wallet_address);
  if (tracking) {
    const newProfitable = pnlPercent > 0 ? tracking.profitable_calls + 1 : tracking.profitable_calls;
    const newTotalPnl = (tracking.total_observed_pnl_percent || 0) + (pnlPercent || 0);
    const newTotalCalls = tracking.total_calls;
    const newAvgDuration = newTotalCalls > 0
      ? ((tracking.avg_position_ms || 0) * (newTotalCalls - 1) + heldDuration) / newTotalCalls
      : heldDuration;

    // Auto-tag
    let tags = [];
    try { tags = JSON.parse(tracking.tags || '[]'); } catch { tags = []; }
    if (pnlPercent > 20 && !tags.includes('smart')) tags.push('smart');
    if (pnlPercent < -30 && !tags.includes('dumper')) tags.push('dumper');

    d.prepare(`
      UPDATE wallet_tracking
      SET profitable_calls = ?, total_observed_pnl_percent = ?, avg_position_ms = ?,
          last_seen_ms = ?, tags = ?
      WHERE address = ?
    `).run(newProfitable, newTotalPnl, newAvgDuration, ts, json(tags), obs.wallet_address);
  }

  return obs.id;
}

/**
 * Get wallets with proven track record (high win rate, multiple calls).
 */
export function getProvenWallets(minCalls = 3, minWinRate = 0.6, dbInstance) {
  const d = dbInstance || defaultDb;
  return d.prepare(`
    SELECT *,
      CASE WHEN total_calls > 0 THEN CAST(profitable_calls AS REAL) / total_calls ELSE 0 END as win_rate
    FROM wallet_tracking
    WHERE total_calls >= ?
      AND is_bot_flag = 0
      AND total_calls > 0
      AND CAST(profitable_calls AS REAL) / total_calls >= ?
    ORDER BY win_rate DESC, total_calls DESC
  `).all(minCalls, minWinRate);
}

/**
 * Get wallet tracking info by address.
 */
export function getWalletByAddress(address, dbInstance) {
  const d = dbInstance || defaultDb;
  return d.prepare('SELECT * FROM wallet_tracking WHERE address = ?').get(address) || null;
}

/**
 * Get observations for a specific wallet.
 */
export function getObservationsByWallet(address, limit = 10, dbInstance) {
  const d = dbInstance || defaultDb;
  return d.prepare(`
    SELECT * FROM wallet_observations WHERE wallet_address = ? ORDER BY observed_at_ms DESC LIMIT ?
  `).all(address, limit);
}

/**
 * Flag a wallet as bot (e.g., from cluster detection).
 */
export function flagWalletAsBot(address, dbInstance) {
  const d = dbInstance || defaultDb;
  d.prepare('UPDATE wallet_tracking SET is_bot_flag = 1 WHERE address = ?').run(address);
}

/**
 * Create wallet_tracking and wallet_observations tables in a test DB.
 */
export function createWalletTables(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS wallet_tracking (
      address TEXT PRIMARY KEY,
      first_seen_ms INTEGER NOT NULL,
      last_seen_ms INTEGER NOT NULL,
      total_calls INTEGER NOT NULL DEFAULT 0,
      profitable_calls INTEGER NOT NULL DEFAULT 0,
      total_observed_pnl_percent REAL NOT NULL DEFAULT 0,
      avg_position_ms REAL NOT NULL DEFAULT 0,
      is_bot_flag INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS wallet_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      mint TEXT NOT NULL,
      position_id INTEGER,
      observed_at_ms INTEGER NOT NULL,
      entry_price REAL,
      entry_mcap REAL,
      holder_pct REAL,
      exit_price REAL,
      exit_mcap REAL,
      pnl_percent REAL,
      held_duration_ms REAL,
      tags TEXT NOT NULL DEFAULT '[]',
      UNIQUE(wallet_address, mint)
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_obs_wallet ON wallet_observations(wallet_address);
    CREATE INDEX IF NOT EXISTS idx_wallet_obs_mint ON wallet_observations(mint);
  `);
}
