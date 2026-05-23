# Dip Buy — Add SOL to Existing Position

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** When a dip buy alert triggers on a token that already has an open position, add more SOL to the existing position instead of skipping.

**Architecture:** Bypass the normal "max positions" guard when the incoming dip token matches an existing open position. Execute a buy-and-add: swap SOL → token, then update the existing position row (averaged entry price, summed size_sol, updated token_amount_raw). Record the additional buy as a trade entry with reason `dip_add`.

**Tech Stack:** Node.js ESM, better-sqlite3, Jupiter swap

---

## Codebase Context

### Current Dip Flow

```
priceMonitor.js → candidateHandler → processCandidateFromSignals()
  → canOpenMorePositions() → skip if max (usually 3) reached
  → buildCandidate() → LLM decide → executeLiveBuy()
  → createLivePosition() → checks mint already open → silently returns existing ID
```

### Key Files

| File | Role |
|------|------|
| `src/pipeline/orchestrator.js` | Candidate processing flow, max position check |
| `src/execution/router.js` | `executeLiveBuy()` — Jupiter swap + position creation |
| `src/db/positions.js` | `createLivePosition()` — DB insert + duplicate mint check |
| `src/signals/priceMonitor.js` | Dip alert trigger → `candidateHandler` |
| `src/db/connection.js` | SQLite schema init |

### DB Schema (relevant columns)

**dry_run_positions table:**
- `id`, `mint` (TEXT), `status` (TEXT), `size_sol` (REAL), `entry_price` (REAL), `entry_mcap` (REAL), `token_amount_raw` (TEXT), `high_water_price` (REAL), `high_water_mcap` (REAL), `execution_mode` (TEXT), `entry_signature` (TEXT), `snapshot_json` (TEXT)

**dry_run_trades table:**
- `position_id`, `mint`, `side` ('buy'/'sell'), `at_ms`, `price`, `mcap`, `size_sol`, `token_amount_est`, `reason`, `payload_json`

### Active Strategy (Dip Buy)
- `position_size_sol: 0.02` — 0.02 SOL per entry
- `max_open_positions: 10`
- Current LLM confidence threshold: 80

---

## Tasks

### Task 1: Add `addToPosition()` to positions.js

**Objective:** Create a DB function that updates an existing position with additional SOL instead of creating a new row.

**Files:**
- Modify: `src/db/positions.js` (append after `createLivePosition`)

**Step 1: Write the function**

Add to `src/db/positions.js`:

```js
/**
 * Add more SOL to an existing open position (dip buy).
 * Averages the entry price/mcap with existing values.
 * Records the additional buy in dry_run_trades.
 */
export function addToPosition(positionId, additionalSizeSol, newEntryPrice, newEntryMcap, newTokenAmount, swapSignature) {
  const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ? AND status = ?').get(positionId, 'open');
  if (!position) throw new Error(`Position #${positionId} not found or not open`);

  const oldSize = Number(position.size_sol);
  const oldPrice = Number(position.entry_price || 0);
  const oldMcap = Number(position.entry_mcap || 0);
  const oldTokenRaw = Number(position.token_amount_raw || 0);
  const newSize = oldSize + additionalSizeSol;

  // Weighted average entry price/mcap
  const avgEntryPrice = oldPrice > 0 && newEntryPrice > 0
    ? (oldSize * oldPrice + additionalSizeSol * newEntryPrice) / newSize
    : (newEntryPrice || oldPrice);
  const avgEntryMcap = oldMcap > 0 && newEntryMcap > 0
    ? (oldSize * oldMcap + additionalSizeSol * newEntryMcap) / newSize
    : (newEntryMcap || oldMcap);

  const newTokenRaw = oldTokenRaw + Number(newTokenAmount || 0);

  db.prepare(`
    UPDATE dry_run_positions
    SET size_sol = ?, entry_price = ?, entry_mcap = ?, token_amount_raw = ?,
        entry_signature = ?, snapshot_json = ?
    WHERE id = ?
  `).run(
    newSize,
    avgEntryPrice,
    avgEntryMcap,
    newTokenRaw > 0 ? String(Math.floor(newTokenRaw)) : position.token_amount_raw,
    swapSignature || position.entry_signature,
    JSON.stringify({
      ...JSON.parse(position.snapshot_json || '{}'),
      dipAdd: {
        atMs: now(),
        amount: additionalSizeSol,
        price: newEntryPrice,
        mcap: newEntryMcap,
        tokenAmount: newTokenAmount,
      },
    }),
    positionId,
  );

  // Record the additional buy as a trade
  db.prepare(`
    INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
    VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, 'dip_add', ?)
  `).run(
    positionId,
    position.mint,
    now(),
    newEntryPrice || position.entry_price,
    newEntryMcap || position.entry_mcap,
    additionalSizeSol,
    newTokenAmount,
    JSON.stringify({ previousSize: oldSize, newSize, avgEntryPrice }),
  );

  return positionId;
}
```

**Step 2: Re-read file to verify format**

Run: `node --check src/db/positions.js`
Expected: no error

**Step 3: Quick smoke test**

Run:
```bash
cd ~/projects/charon && node -e "
const { addToPosition, openPositions } = require('./src/db/positions.js');
const opens = openPositions();
console.log('Open positions:', opens.length);
if (opens.length > 0) {
  const p = opens[opens.length - 1];
  console.log('Would add 0.02 SOL to #' + p.id, p.mint.slice(0,8) + '...');
  const prevSize = p.size_sol;
  // Don't actually call, just verify function exists
  console.log('addToPosition exported:', typeof addToPosition);
}
"
```

Expected: Exports successfully, function type is 'function'.

No commit yet — this function isn't called anywhere.

---

### Task 2: Add `executeDipAdd()` to router.js

**Objective:** Create the execution function that performs a Jupiter swap and adds to the existing position.

**Files:**
- Modify: `src/execution/router.js` (append after `executeConfirmedIntent`)

**Step 1: Write the function**

Add to `src/execution/router.js`:

```js
/**
 * Execute an additional buy on an existing position (dip add).
 * Skips honeypot check (already passed during initial entry).
 * Uses the strategy's position_size_sol for the additional amount.
 */
export async function executeDipAdd(existingPosition, decision, selectedRow, batchId) {
  const strat = activeStrategy();
  const amountLamports = Math.floor((strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1)) * 1_000_000_000);
  const balance = await liveWalletBalanceLamports();
  if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
    throw new Error(`Insufficient SOL balance for dip add. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL including reserve.`);
  }

  const swap = await executeJupiterSwap({
    inputMint: WSOL_MINT,
    outputMint: existingPosition.mint,
    amount: amountLamports,
  });

  if (!swap.outputAmount) {
    swap.outputAmount = await fetchLiveTokenBalance(existingPosition.mint) || swap.outputAmount;
  }

  const additionalSol = amountLamports / 1_000_000_000;
  const newEntryPrice = Number(selectedRow?.candidate?.metrics?.priceUsd || existingPosition.entry_price || 0);
  const newEntryMcap = Number(selectedRow?.candidate?.metrics?.marketCapUsd || existingPosition.entry_mcap || 0);

  addToPosition(
    existingPosition.id,
    additionalSol,
    newEntryPrice,
    newEntryMcap,
    swap.outputAmount,
    swap.signature,
  );

  logDecisionEvent({
    batchId,
    triggerCandidateId: selectedRow?.id || null,
    selectedRow,
    mode: 'live',
    action: 'dip_add_executed',
    guardrails: { balanceLamports, amountLamports, positionId: existingPosition.id },
    execution: { positionId: existingPosition.id, swap, additionalSol },
  });

  return swap;
}
```

**Step 2: Add the import**

At the top of `router.js`, add:
```js
import { addToPosition } from '../db/positions.js';
```

**Step 3: Verify**

Run: `node --check src/execution/router.js`
Expected: no error

---

### Task 3: Add `findOpenPositionByMint()` to positions.js

**Objective:** Simple query to check if a mint already has an open position.

**Files:**
- Modify: `src/db/positions.js`

**Step 1: Add function**

Add after `openPositionCount()`:

```js
export function findOpenPositionByMint(mint) {
  return db.prepare("SELECT * FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1").get(mint) || null;
}
```

**Step 2: Verify**

Run: `node --check src/db/positions.js`
Expected: no error

---

### Task 4: Modify orchestrator.js — dip add routing

**Objective:** In `processCandidateFromSignals()`, detect when dip is on an already-open token and route to dip add instead of normal buy flow.

**Files:**
- Modify: `src/pipeline/orchestrator.js`

**Logic change:**

After line 33 (`const candidate = await buildCandidate(signals);`) and before the `canOpenMorePositions()` check:

1. Check if route starts with `dip_`
2. If yes, check if mint already has an open position
3. If yes → skip LLM decision, skip canOpenMorePositions, execute dip add directly
4. If not dip_or no existing position → proceed as normal

**Step 1: Add imports**

At the top of `orchestrator.js`, add `findOpenPositionByMint` to the import from `'../db/positions.js'`, and add `executeDipAdd` import from `'../execution/router.js'`:

```js
import { createDryRunPosition, createLivePosition, canOpenMorePositions, openPositionCount, findOpenPositionByMint, addToPosition, tradingMode } from '../db/positions.js';
import { executeLiveBuy, executeDipAdd } from '../execution/router.js';
```

**Step 2: Add dip add logic**

In `processCandidateFromSignals()`, after line 33 (after `const candidate = await buildCandidate(signals);`), add:

```js
  // ─── Dip add: if signal is dip_ route and mint already has open position, add to it ───
  const isDipRoute = (signals.route || '').startsWith('dip_');
  const existingPos = isDipRoute && candidate.token?.mint
    ? findOpenPositionByMint(candidate.token.mint)
    : null;

  if (existingPos) {
    console.log(`[dip] ${candidate.token.mint.slice(0, 8)}... already open at position #${existingPos.id} (${existingPos.size_sol} SOL), adding...`);
    sendTelegram([
      `💧 <b>Dip add: ${escapeHtml(candidate.token.symbol || '?')}</b>`,
      `Position: #${existingPos.id}`,
      `Current size: ${existingPos.size_sol} SOL`,
      `Adding: ${numSetting('dry_run_buy_sol', 0.1)} SOL`,
      `Price: $${candidate.metrics.priceUsd || '?'}`,
    ].join('\n')).catch(() => {});

    // Record a quick decision for logging
    const quickDecision = {
      verdict: 'BUY',
      confidence: 100,
      selected_candidate_id: candidateId,
      selected_mint: candidate.token.mint,
      reason: `Dip add on existing position #${existingPos.id}`,
      risks: [],
      suggested_tp_percent: existingPos.tp_percent,
      suggested_sl_percent: existingPos.sl_percent,
    };
    const quickDecisionId = storeDecision(candidateId, candidate, quickDecision);

    const mode = tradingMode();
    if (mode === 'live') {
      try {
        const selectedRow = candidateById(candidateId);
        const swap = await executeDipAdd(existingPos, quickDecision, selectedRow, null);
        console.log(`[dip] added ${candidate.token.mint.slice(0, 8)}... position #${existingPos.id} now ${Number(existingPos.size_sol) + 0.04} SOL`);
      } catch (err) {
        console.log(`[dip] add failed for ${candidate.token.mint.slice(0, 8)}...: ${err.message}`);
        sendTelegram([
          `🛑 <b>Dip add failed</b>`,
          `Token: <a href="https://gmgn.ai/sol/token/${candidate.token.mint}">${escapeHtml(candidate.token.symbol || '?')}</a>`,
          `Position: #${existingPos.id}`,
          `Error: ${escapeHtml(err.message)}`,
        ].join('\n')).catch(() => {});
      }
    } else {
      // Dry-run / confirm — just log it
      const strat = activeStrategy();
      const amountSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
      addToPosition(existingPos.id, amountSol, candidate.metrics.priceUsd, candidate.metrics.marketCapUsd, null, null);
      console.log(`[dip] dry-run added ${amountSol} SOL to position #${existingPos.id}`);
      if (mode === 'dry_run') {
        sendTelegram([
          `💧 <b>Dip add (dry-run)</b>`,
          `Position: #${existingPos.id} (${escapeHtml(candidate.token.symbol || '?')})`,
          `Added: ${amountSol} SOL`,
          `New total: ${(Number(existingPos.size_sol) + amountSol).toFixed(4)} SOL`,
        ].join('\n')).catch(() => {});
      }
    }

    updateCandidateStatus(candidateId, 'dip_added');
    return;
  }
```

This block should go AFTER `buildCandidate` + `upsertCandidate`, and BEFORE the `canOpenMorePositions()` check.

**Step 3: Verify**

Run: `node --check src/pipeline/orchestrator.js`
Expected: no error

---

### Task 5: Verify end-to-end

**Objective:** Ensure the dip add flow doesn't break anything.

**Step 1: Quick restart**

```bash
pm2 restart charon --update-env
```

**Step 2: Check startup logs**

```bash
pm2 logs charon --lines 30 --nostream
```

Expected: No startup errors. Confirm Charon is running with `pm2 list`.

**Step 3: Check that existing dip alerts still trigger**

Wait for the next price monitor cycle. Monitor logs:
```bash
pm2 logs charon --lines 50 --nostream
```

Expected: Dip buys on NEW tokens still work as before. Dip buys on EXISTING open positions show:
```
[dip] xxx... already open at position #N (0.02 SOL), adding...
```

---

## Files Changed Summary

| File | Change |
|------|--------|
| `src/db/positions.js` | + `findOpenPositionByMint(mint)`, + `addToPosition(positionId, ...)` |
| `src/execution/router.js` | + `executeDipAdd(existingPosition, ...)`, + import `addToPosition` |
| `src/pipeline/orchestrator.js` | + dip add routing logic after `buildCandidate()`, + imports |

## Verification Steps

1. `pm2 logs charon` shows no errors
2. Dip buy on a NEW token → opens position (existing flow)
3. Dip buy on a token with open position → shows `[dip] ... adding...` log
4. Telegram receives `💧 Dip add` notification
5. `addToPosition()` updates `size_sol` correctly (check via `/positions` command)
6. Position exits use AVERAGED entry price, not original entry

## Design Decisions

- **Skip LLM for dip adds** — dip add is purely mechanical: dip hits target → buy more. No need for LLM deliberation.
- **Use strategy's `position_size_sol`** for the add amount — same amount as initial buy, configurable per strategy.
- **Weighted average entry price** — so TP/SL calculations use the blended cost basis, not just original entry.
- **Record `dip_add` trade reason** — transparency in trade history, distinguishable from original buy.
- **Telegram notification** — visible confirmation that the add happened.
