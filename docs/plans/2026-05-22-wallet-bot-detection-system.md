# Charon — Wallet & Bot Detection System

> **For Hermes:** Use subagent-driven-development skill to implement this plan phase-by-phase, task-by-task. Each phase is independent but builds on previous phases.

**Goal:** Detect bots, clusters, smart wallets, and risky holder patterns in Charon's candidate screening pipeline — so the bot isn't exit liquidity for automated actors.

**Architecture:** Add a new `src/analysis/` module for on-chain wallet profiling. Integrate results into `candidateBuilder.js` as additional filter failures and into the LLM prompt as enriched context. Use Helius RPC (already configured) for on-chain queries. Phase approach: data collection → analysis → integration → persistent tracking.

**Tech Stack:** Node.js ESM, `@solana/web3.js` (Connection already exists), Helius RPC, Jupiter API (already used), SQLite (for persistent wallet tracking).

---

## Codebase Context

### Existing Related Code

| File | What It Has |
|------|-------------|
| `src/enrichment/jupiter.js` | `fetchJupiterHolders()` — returns top 20 holders with address, amount, %, tags |
| `src/enrichment/wallets.js` | `savedWallets()`, `fetchSavedWalletExposure()`, `fetchWalletPnl()` (unused!) |
| `src/pipeline/candidateBuilder.js` | `filterCandidate()` — checks `max_top20_holder_percent`, `max_bundler_rate`, etc |
| `src/pipeline/llm.js` | `compactCandidateForLlm()` — passes holders data to LLM |
| `src/liveExecutor.js` | `Connection` to Helius RPC — already have `getBalance`, `getParsedTokenAccountsByOwner` |
| `src/config.js` | `HELIUS_API_KEY`, `SOLANA_RPC_URL` |

### DB Tables (relevant)

**`saved_wallets`** — label, address, created_at_ms (currently empty)
**`dry_run_positions`** — mint, symbol, status (open/closed), size_sol, pnl_percent/sol, etc

### Missing Tables (to create)
- `wallet_tracking` — wallet address → win rate, call count, first detected, last detected
- `wallet_observations` — per-token observation of wallet behavior

---

## Phase 1: On-Chain Wallet Profiler

**Objective:** Build a reusable module that takes a wallet address and returns its profile (age, SOL balance, holdings, risk level).

### Task 1.1: Create `src/analysis/walletProfile.js`

**Objective:** Query Helius RPC for wallet metadata.

**Files:**
- Create: `src/analysis/walletProfile.js`

**Key functions:**

```js
import { Connection, PublicKey } from '@solana/web3.js';
import { SOLANA_RPC_URL } from '../config.js';

const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

/**
 * Get SOL balance of a wallet. Returns SOL (not lamports).
 */
export async function walletSolBalance(address) {
  // connection.getBalance(publicKey) → lamports
  // Return SOL value or 0 on error
}

/**
 * Get first transaction timestamp of a wallet.
 * connection.getSignaturesForAddress(publicKey, {limit: 1})
 * Last entry = oldest tx → blockTime
 * Returns unix ms or null if never transacted.
 */
export async function walletAgeMs(address) {
  // getSignaturesForAddress → oldest sig → blockTime
  // Return Date.now() - blockTime*1000 (age in ms) or null
}

/**
 * Count unique token mints this wallet holds (excl SOL).
 * connection.getParsedTokenAccountsByOwner(publicKey)
 * Filter: tokenAmount.amount > 0
 * Return count.
 */
export async function walletDistinctTokensHeld(address) {
  // getParsedTokenAccountsByOwner → filter non-zero → count
}

/**
 * Check if wallet is new (< 24h since first tx) and has near-zero SOL.
 * Combines walletAgeMs + walletSolBalance.
 * Returns { isNew, isDust, ageHours, solBalance }
 */
export async function walletRiskProfile(address) {
  // age = walletAgeMs(address)
  // sol = walletSolBalance(address)
  // isNew = age < 24h
  // isDust = sol < 0.01 SOL
  // Return combined profile
}
```

### Task 1.2: Verify it works

**Step:** Quick test

```bash
cd ~/projects/charon && node --experimental-vm-modules -e "
import { walletSolBalance, walletAgeMs, walletDistinctTokensHeld } from './src/analysis/walletProfile.js';
// Test with a known wallet
console.log('Testing wallet profiling...');
// Don't call yet, just verify exports
console.log('Module loaded successfully');
"
```

---

## Phase 2: Funding Cluster Detection

**Objective:** Trace the SOL funding source of top holders to detect bot clusters (multiple wallets funded from the same source).

### Task 2.1: Create `src/analysis/clusterDetection.js`

**Files:**
- Create: `src/analysis/clusterDetection.js`

**Logic:**

```
For each wallet in top 10 holders:
  → Get first outbound tx or earliest inbound SOL transfer
  → Find who funded them (sender of first SOL received)
  
Group wallets by funding source:
  → clusterCount = wallets funded by same source
  → clusterPct = clusterCount / totalHoldersChecked * 100
  
Risk thresholds:
  - 3+ wallets from same source = CLUSTER (flag)
  - 5+ wallets from same source = BOT_ARMY (hard skip)
```

**Key functions:**

```js
/**
 * For each holder address, find who sent them their first SOL.
 * connection.getSignaturesForAddress → filter for system program transfers → connection.getTransaction
 * Extract fee payer / source of first transfer-in
 */
export async function findFundingSources(holders) {
  // For each address in holders.slice(0, 10):
  //   1. Get earliest tx that transferred SOL in
  //   2. Extract the "from" address
  // Return Map<sourceAddress, walletAddresses[]>
}

/**
 * Detect clusters from funding sources.
 * Returns { clusterFound, clusterCount, maxClusterSize, clusters: [{source, wallets, count}], score }
 */
export async function detectClusters(holders) {
  // sources = await findFundingSources(holders)
  // Group by source
  // Score: 0-100 where 100 = all wallets from same source
  // Return detection result with risk level
}
```

### Task 2.2: Quick test

Run against a known token's holders:

```bash
cd ~/projects/charon && node --experimental-vm-modules -e "
import { detectClusters } from './src/analysis/clusterDetection.js';
// Quick test with placeholder
console.log('Cluster detection module loaded');
"
```

---

## Phase 3: Uniform Pattern Detection

**Objective:** Detect bot-like buying patterns (identical amounts, sequential timing, identical sell timing).

### Task 3.1: Create `src/analysis/patternDetection.js`

**Files:**
- Create: `src/analysis/patternDetection.js`

**Logic:**

```
Given top 10 holders with their amounts:
  → Check how many hold EXACTLY the same amount (within 0.1% tolerance)
  → uniformBuyCount = wallets with matching amounts

Given first tx timestamps of holders:
  → Check if buys happened within seconds of each other
  → sequentialBuyCount = wallets with first buy within 2 blocks of each other

Return:
  - uniformAmountPct: % of holders with identical amounts
  - sequentialTimingPct: % of holders who bought in rapid succession
  - botPatternScore: 0-100 combined score
```

**Key functions:**

```js
/**
 * Detect wallets holding suspiciously uniform amounts.
 * amountTolerance = 0.001 (0.1% tolerance for "uniform")
 */
export function detectUniformAmounts(holders, amountTolerance = 0.001) {
  // Group holders by amount (within tolerance)
  // Return count and % of holders in the largest uniform group
}

/**
 * Detect wallets with sequential buy timing.
 * intervalMs = 3000 (3 seconds = 2 blocks)
 */
export function detectSequentialBuys(holdersWithFirstTxTime, intervalMs = 3000) {
  // Sort by first tx time
  // Count wallets within intervalMs of another wallet in the list
  // Return count and %
}

/**
 * Combined bot pattern score 0-100
 */
export function botPatternScore(holders) {
  // uniform = detectUniformAmounts(holders)
  // sequential = detectSequentialBuys(holdersWithTimes)
  // Return weighted score
}
```

---

## Phase 4: Smart Wallet Tracking (Persistent)

**Objective:** Track wallet performance over time — which wallets consistently call tokens early and profit → build a "proven smart wallet" database.

### Task 4.1: DB Migration — Add wallet tracking tables

**Files:**
- Modify: `src/db/connection.js` (add tables to `initDb()`)

```sql
CREATE TABLE IF NOT EXISTS wallet_tracking (
  address TEXT PRIMARY KEY,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  total_calls INTEGER NOT NULL DEFAULT 0,        -- total tokens where they were in top 20 at entry
  profitable_calls INTEGER NOT NULL DEFAULT 0,     -- tokens that closed with positive PnL
  total_observed_pnl_percent REAL NOT NULL DEFAULT 0,  -- sum of all observed PnL %
  avg_position_ms REAL NOT NULL DEFAULT 0,         -- average hold time
  is_bot_flag INTEGER NOT NULL DEFAULT 0,          -- 1 = detected as bot cluster
  tags TEXT NOT NULL DEFAULT '[]'                  -- JSON array of tags: ["early_caller","whale","smart"]
);

CREATE TABLE IF NOT EXISTS wallet_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  mint TEXT NOT NULL,
  position_id INTEGER,
  observed_at_ms INTEGER NOT NULL,                 -- when we detected them
  entry_price REAL,
  entry_mcap REAL,
  holder_pct REAL,                                 -- % of supply they held
  exit_price REAL,
  exit_mcap REAL,
  pnl_percent REAL,                                -- filled when position closes
  held_duration_ms REAL,                           -- how long they held (filled on close)
  tags TEXT NOT NULL DEFAULT '[]',
  UNIQUE(wallet_address, mint)
);
```

### Task 4.2: Create `src/analysis/walletTracker.js`

**Files:**
- Create: `src/analysis/walletTracker.js`

**Logic:**

```js
/**
 * Record observation: wallet X was in top holders of token Y at entry time.
 */
export function recordWalletObservation(walletAddress, mint, holderPct, entryPrice, entryMcap, tags) {
  // INSERT OR IGNORE into wallet_observations
  // UPSERT into wallet_tracking: increment total_calls, update last_seen_ms
}

/**
 * Update observation when position closes.
 * positionId = the closed position ID
 * exitPrice, exitMcap, pnlPercent from position close
 */
export function updateWalletObservationOnClose(positionId, exitPrice, exitMcap, pnlPercent) {
  // Find wallet_observation for this position_id
  // Update: exit_price, exit_mcap, pnl_percent, held_duration_ms
  // Update wallet_tracking: profitable_calls++, total_observed_pnl_percent
  // Auto-tag: if pnl > 20% → tag "smart", if pnl < -30% → tag "dumper"
}

/**
 * Get proven smart wallets for a token (wallets that have profitable history).
 * Returns addresses with their win rate and average PnL.
 */
export function getProvenWallets(minCalls = 3, minWinRate = 0.6) {
  // SELECT from wallet_tracking WHERE total_calls >= minCalls
  // AND profitable_calls / total_calls >= minWinRate
  // AND is_bot_flag = 0
  // Return sorted by win rate desc, with avg PnL
}
```

---

## Phase 5: Integration into Candidate Flow

**Objective:** Hook wallet profiling results into `filterCandidate()` and the LLM prompt.

### Task 5.1: Create `src/analysis/analyzeCandidate.js`

**Objective:** Orchestrate all analysis modules for a candidate token.

**Files:**
- Create: `src/analysis/analyzeCandidate.js`

```js
import { walletRiskProfile } from './walletProfile.js';
import { detectClusters } from './clusterDetection.js';
import { botPatternScore } from './patternDetection.js';
import { recordWalletObservation, getProvenWallets } from './walletTracker.js';

/**
 * Run full wallet + bot analysis on a candidate.
 * Called from candidateBuilder.js after fetchJupiterHolders.
 * Returns analysis result object with scores and filters.
 */
export async function analyzeWalletLayer(candidate) {
  const holders = candidate.holders?.holders || [];
  if (!holders.length) return { passed: true, warnings: [], scores: {} };
  
  const top10 = holders.slice(0, 10);
  
  // Phase 1: Individual wallet risk profiles
  const profiles = await Promise.allSettled(
    top10.map(h => walletRiskProfile(h.address))
  );
  
  // Phase 2: Funding cluster detection  
  const cluster = await detectClusters(holders);
  
  // Phase 3: Pattern detection
  const patterns = botPatternScore(holders);
  
  // Phase 4: Check known wallets
  const provenWallets = getProvenWallets();
  const haveSmartWallet = top10.some(h => 
    provenWallets.some(w => w.address === h.address)
  );
  
  // Record observations for tracking
  top10.forEach(h => {
    recordWalletObservation(h.address, candidate.token.mint, h.percent, null, null, []);
  });
  
  // Build scores
  const newWalletPct = profiles.filter(p => p.value?.isNew).length / top10.length * 100;
  const dustWalletPct = profiles.filter(p => p.value?.isDust).length / top10.length * 100;
  
  // Build failures
  const failures = [];
  if (cluster.maxClusterSize >= 5) failures.push(`bot cluster: ${cluster.maxClusterSize} wallets from same source`);
  if (newWalletPct > 50) failures.push(`new wallets: ${newWalletPct.toFixed(0)}% holders < 24h old`);
  if (dustWalletPct > 30) failures.push(`dust wallets: ${dustWalletPct.toFixed(0)}% holders have < 0.01 SOL`);
  
  return {
    passed: failures.length === 0,
    failures,
    scores: {
      newWalletPct,
      dustWalletPct,
      clusterScore: cluster.score,
      patternScore: patterns,
      haveSmartWallet,
    },
    clusterDetails: cluster,
    walletProfiles: profiles.map((p, i) => ({ address: top10[i].address, ...p.value })),
  };
}
```

### Task 5.2: Hook into filterCandidate()

**Files:**
- Modify: `src/pipeline/candidateBuilder.js`

In `filterCandidate()`, after existing strategy checks, integrate wallet analysis:

```js
// Wallet & bot analysis — async, so we need to call it differently
// Option A: Call in buildCandidate() after filterCandidate() — cleaner
// Option B: Make entire buildCandidate async-aware of filters
```

**Recommended approach:** In `buildCandidate()`, after `candidate.filters = filterCandidate(candidate)`:

```js
// Run wallet analysis (async)
const walletAnalysis = await analyzeWalletLayer(candidate);
candidate.walletAnalysis = walletAnalysis;
// Only add to filter failures if initial filters passed
if (candidate.filters.passed && !walletAnalysis.passed) {
  candidate.filters = {
    passed: false,
    failures: walletAnalysis.failures,
    strategy: candidate.filters.strategy,
  };
}
```

### Task 5.3: Add wallet data to LLM prompt

**Files:**
- Modify: `src/pipeline/llm.js` — in `compactCandidateForLlm()`

Add to the returned object:
```js
walletAnalysis: c.walletAnalysis ? {
  newWalletPct: c.walletAnalysis.scores.newWalletPct,
  dustWalletPct: c.walletAnalysis.scores.dustWalletPct,
  clusterDetected: c.walletAnalysis.scores.clusterScore > 30,
  patternScore: c.walletAnalysis.scores.patternScore,
  haveSmartWallet: c.walletAnalysis.scores.haveSmartWallet,
  clusterCount: c.walletAnalysis.clusterDetails?.maxClusterSize || 0,
  topWallets: c.walletAnalysis.walletProfiles?.slice(0, 5).map(w => ({
    addr: w.address.slice(0, 8) + '...',
    ageHours: w.ageHours > 0 ? Math.round(w.ageHours) : 'unknown',
    sol: w.solBalance?.toFixed(3),
    isNew: w.isNew,
    isDust: w.isDust,
  })),
} : null,
```

---

## Phase 6: Close Position — Update Wallet Observations

**Objective:** When a position closes, update wallet observations with the outcome.

### Task 6.1: Hook into position close

**Files:**
- Modify: `src/execution/positions.js` — in `refreshPosition()` after position closed

Add after line ~242 (position close block):
```js
// Update wallet observations with exit data
if (closed) {
  try {
    const { updateWalletObservationOnClose } = await import('../analysis/walletTracker.js');
    await updateWalletObservationOnClose(position.id, exitPrice, mcap, finalPnlPercent);
  } catch (err) {
    // Non-critical — don't break position close
    console.log(`[walletTrack] update failed for #${position.id}: ${err.message}`);
  }
}
```

---

## Phase 7: Strategy Config — Wallet Risk Thresholds

**Objective:** Add strategy config keys for wallet/bot detection thresholds.

**Files:**
- Modify: Strategy `config_json` in DB (runtime, no code change needed for new keys)

**New strategy config keys (optional — default to disabled):**

```json
{
  "max_bot_cluster_size": 3,        // skip if 3+ wallets from same funding source
  "max_new_wallet_pct": 50,         // skip if >50% holders are <24h old
  "max_dust_wallet_pct": 30,        // skip if >30% holders have <0.01 SOL
  "max_uniform_amount_pct": 40,     // skip if >40% holders have identical amounts
  "require_smart_wallet": false     // require at least 1 proven smart wallet
}
```

These integrate into `filterCandidate()` like existing checks.

---

## Phase 8: Telegram Commands — Wallet Info

**Objective:** Add Telegram commands to query wallet data and detected clusters.

**Files:**
- Modify: `src/telegram/commands.js`

**New commands:**

- `/wallet <address>` — Show wallet profile (age, SOL balance, holdings count, win rate if tracked)
- `/whales <mint>` — Show top 10 holders with wallet analysis (new/dust/cluster flags)
- `/tracked` — List tracked smart wallets (top 10 by win rate)

---

## Files Changed Summary

| Phase | File | Change |
|-------|------|--------|
| 1 | `src/analysis/walletProfile.js` | **Create** — wallet age, SOL balance, holdings |
| 2 | `src/analysis/clusterDetection.js` | **Create** — funding cluster detection |
| 3 | `src/analysis/patternDetection.js` | **Create** — uniform amount/timing patterns |
| 4 | `src/db/connection.js` | **Modify** — add wallet_tracking + wallet_observations tables |
| 4 | `src/analysis/walletTracker.js` | **Create** — persistent smart wallet tracking |
| 5 | `src/analysis/analyzeCandidate.js` | **Create** — orchestrator for all analysis modules |
| 5 | `src/pipeline/candidateBuilder.js` | **Modify** — hook wallet analysis into filterCandidate |
| 5 | `src/pipeline/llm.js` | **Modify** — add wallet analysis to LLM prompt |
| 6 | `src/execution/positions.js` | **Modify** — update wallet tracking on position close |
| 8 | `src/telegram/commands.js` | **Modify** — /wallet, /whales, /tracked commands |

---

## Verification Flow

```
1. New signal arrives → buildCandidate()
2. fetchJupiterHolders() → top 20 holders with addresses
3. analyzeWalletLayer() runs:
   a. walletProfile.js → SOL balance, age for each top 10 holder
   b. clusterDetection.js → funding sources, cluster count
   c. patternDetection.js → uniform amounts, sequential buys
   d. walletTracker.js → check proven wallets
4. If analysis fails filters → signal filtered with reason "bot cluster: 5 wallets from same source"
5. If passes → data injected into LLM prompt
6. On position close → walletTracker records outcome
7. Over time → wallet tracking builds database of proven winners/losers
```

## Success Criteria

- [ ] RPC calls don't slow down candidate evaluation (< 5s per token)
- [ ] Bot clusters detected with < 5% false positive rate
- [ ] New wallet / dust wallet detection catches pump-dump schemes
- [ ] Smart wallet tracking correctly identifies consistent winners after 20+ closed positions
- [ ] LLM can see wallet analysis in its decision context
- [ ] Strategy config can turn individual checks on/off

## Performance Notes

**RPC concerns:** `getSignaturesForAddress` + `getTransaction` per wallet = potentially slow. For top 10 holders = 10-20 RPC calls. Mitigations:
1. **Cache wallet profiles** per address with 5-minute TTL (wallet data rarely changes)
2. **Batch** if Helius supports it
3. **Skip** analysis if wallet count is small (< 5 holders)
4. **Rate limit** — max 1 analysis per token, skip if within 60s of last analysis of same token

## Edge Cases

- **No RPC data** for fresh wallets (first tx in mempool but not confirmed) → treat as "unknown" not "failed"
- **Wallet with no SOL transfers** (was airdropped) → age = 0, isDust = true (flag)
- **CEX deposit wallets** (tagged by Jupiter) → skip cluster detection (many share a CEX funding source)
- **Token mints with < 5 holders** → skip analysis (insufficient data)
