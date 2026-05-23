import { now, pruneSeen } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { upsertCandidate, updateCandidateStatus, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, logDecisionEvent } from '../db/decisions.js';
import { buildCandidate, filterCandidate, signalLabel } from './candidateBuilder.js';
import { decideCandidateBatch } from './llm.js';
import { activeStrategy } from '../db/settings.js';
import { createDryRunPosition, createLivePosition, canOpenMorePositions, openPositionCount, tradingMode } from '../db/positions.js';
import { sendBatchReveal, sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { createTradeIntent } from '../db/intents.js';
import { refreshCandidateForExecution } from '../execution/positions.js';
import { executeLiveBuy } from '../execution/router.js';
import { graduated } from '../signals/graduated.js';
import { setDegenHandler } from '../signals/trending.js';
import { setCandidateHandler } from '../signals/feeClaim.js';
import { short } from '../format.js';
import { escapeHtml } from '../format.js';

export const seenSignalCandidates = new Map();

// Cache of recently-filtered tokens to avoid re-checking the same dead tokens
// Key: mint address, Value: timestamp. Pruned after FILTERED_TTL_MS.
const FILTERED_TTL_MS = 60 * 60 * 1000; // 1 hour
const recentlyFilteredTokens = new Map();

// Cross-source dedup: track ALL mints processed (filtered or not) within TTL
// so a token from signal server isn't reprocessed when GMGN discovery finds it.
// Key: mint address, Value: timestamp.
const PROCESSED_TTL_MS = 60 * 60 * 1000; // 1 hour
const processedTokens = new Map();

// In-flight lock to prevent parallel processing of the same mint from
// multiple paths (signal server + dip price monitor).
const pendingProcessing = new Set();

setDegenHandler(maybeProcessDegenCandidate);
setCandidateHandler(processCandidateFromSignals);

export async function processCandidateFromSignals(signals) {
  const mint = signals.mint;
  if (!mint) return;

  // Skip if max positions reached — don't waste enrichment/LLM calls
  if (!canOpenMorePositions()) {
    const max = numSetting('max_open_positions', 3);
    console.log(`[agent] max positions reached (${openPositionCount()}/${max}), skipping ${mint.slice(0, 8)}...`);
    return;
  }

  // Skip recently-filtered tokens to avoid re-checking dead tokens every cycle
  pruneSeen(recentlyFilteredTokens, FILTERED_TTL_MS);
  if (recentlyFilteredTokens.has(mint)) {
    console.log(`[agent] skipping recently-filtered ${mint.slice(0, 8)}... (cached ${Math.round((now() - recentlyFilteredTokens.get(mint)) / 60000)}m ago)`);
    return;
  }

  // Cross-source dedup: skip if already processed by another signal source
  // e.g. token from signal server shouldn't be reprocessed by GMGN discovery
  pruneSeen(processedTokens, PROCESSED_TTL_MS);
  if (processedTokens.has(mint)) {
    const ageMin = Math.round((now() - processedTokens.get(mint)) / 60000);
    console.log(`[agent] skipping already-processed ${mint.slice(0, 8)}... from ${signals.route || '?'} (processed ${ageMin}m ago)`);
    return;
  }

  // In-flight lock: skip if this mint is already being processed
  if (pendingProcessing.has(mint)) {
    console.log(`[agent] already processing ${mint.slice(0, 8)}..., skipping duplicate`);
    return;
  }
  pendingProcessing.add(mint);
  // Mark as processed across all sources immediately — even if it later fails,
  // we don't want another source re-processing it within the TTL window.
  processedTokens.set(mint, now());

  try {
    const candidate = await buildCandidate(signals);
    const signature = signals.signature || null;
    const candidateId = upsertCandidate(candidate, signature);
    if (!candidate.filters.passed) {
      const failures = candidate.filters.failures.join('; ');
      const symbol = candidate.token?.symbol || candidate.token?.mint?.slice(0, 8) || '?';
      const route = candidate.signals?.route || 'signal';
      console.log(`[candidate] filtered ${candidate.token.mint.slice(0, 8)}... ${failures}`);
      recentlyFilteredTokens.set(mint, now());
      sendTelegram([
        `📡 <b>Signal filtered</b>`,
        `Token: <a href="https://gmgn.ai/sol/token/${candidate.token.mint}">${escapeHtml(symbol)}</a> (${candidate.token.mint.slice(0, 8)}...)`,
        `Route: ${escapeHtml(route)}`,
        `Filtered: ${escapeHtml(failures)}`,
      ].join('\n')).catch(() => {});
      return;
    }

    const strat = activeStrategy();
    let rows, batchDecision, batchId;

    if (!strat.use_llm) {
      const selfRow = candidateById(candidateId);
      rows = selfRow ? [selfRow] : [];
      batchId = null;
      batchDecision = {
        verdict: 'BUY',
        confidence: 100,
        selected_candidate_id: candidateId,
        selected_mint: candidate.token.mint,
        selected_row: selfRow,
        reason: `Strategy '${strat.id}' is rule-based (use_llm: false); filters passed.`,
        risks: [],
        suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
        suggested_sl_percent: strat.sl_percent ?? numSetting('default_sl_percent', -25),
        raw: null,
      };
    } else {
      rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
      batchDecision = await decideCandidateBatch(rows, candidateId);
      batchId = storeBatchDecision(candidateId, rows, batchDecision);
    }
    const selectedRow = batchDecision.selected_row;
    const selectedThisCandidate = selectedRow?.id === candidateId;
    const currentDecision = selectedThisCandidate
      ? batchDecision
      : {
          ...batchDecision,
          verdict: 'WATCH',
          reason: selectedRow
            ? `Batch #${batchId} screened ${rows.length}; selected ${short(selectedRow.candidate.token.mint)} instead. ${batchDecision.reason || ''}`.trim()
            : `Batch #${batchId} screened ${rows.length}; no buy selected. ${batchDecision.reason || ''}`.trim(),
        };
    const currentDecisionId = storeDecision(candidateId, candidate, currentDecision);
    currentDecision.id = currentDecisionId;
    updateCandidateStatus(candidateId, currentDecision.verdict.toLowerCase());

    if (selectedRow && !selectedThisCandidate) {
      const selectedDecisionId = storeDecision(selectedRow.id, selectedRow.candidate, batchDecision);
      batchDecision.id = selectedDecisionId;
      updateCandidateStatus(selectedRow.id, batchDecision.verdict.toLowerCase());
    } else if (selectedThisCandidate) {
      batchDecision.id = currentDecisionId;
    }

    if (batchId) await sendBatchReveal(batchId, rows, batchDecision, candidateId);

    if (selectedRow && boolSetting('agent_enabled', true) && batchDecision.verdict === 'BUY' && batchDecision.confidence >= numSetting('llm_min_confidence', 75)) {
      if (!canOpenMorePositions()) {
        const max = numSetting('max_open_positions', 3);
        console.log(`[agent] max open positions reached (${openPositionCount()}/${max}), skipping buy ${selectedRow.candidate.token.mint}`);
        logDecisionEvent({
          batchId,
          triggerCandidateId: candidateId,
          selectedRow,
          rows,
          decision: batchDecision,
          action: 'entry_skipped_max_positions',
          guardrails: { maxOpenPositions: max, openPositions: openPositionCount() },
        });
        return;
      }
      await handleApprovedBuy(selectedRow, batchDecision, batchId, rows, candidateId);
    } else {
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
        guardrails: {
          agentEnabled: boolSetting('agent_enabled', true),
          confidenceThreshold: numSetting('llm_min_confidence', 75),
          openPositions: openPositionCount(),
          maxOpenPositions: numSetting('max_open_positions', 3),
        },
      });
    }
  } finally {
    pendingProcessing.delete(mint);
  }
}

export async function handleApprovedBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const mode = tradingMode();
  const freshSelectedRow = await refreshCandidateForExecution(selectedRow);
  const executionRows = rows.map(row => row.id === freshSelectedRow.id ? freshSelectedRow : row);
  if (!freshSelectedRow.candidate.filters?.passed) {
    updateCandidateStatus(freshSelectedRow.id, 'stale_rejected');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'entry_rejected_fresh_filters',
      guardrails: {
        failures: freshSelectedRow.candidate.filters?.failures || [],
        refreshedAtMs: freshSelectedRow.candidate.executionRefresh?.refreshedAtMs,
      },
    });
    await sendTelegram([
      '🛑 <b>Execution rejected on fresh check</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Failures: ${escapeHtml((freshSelectedRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
    ].join('\n'));
    return;
  }

  if (mode === 'dry_run') {
    const positionId = await createDryRunPosition(freshSelectedRow.id, freshSelectedRow.candidate, decision, `llm_batch_${batchId}`);
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'dry_run_entry',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { positionId },
    });
    await sendPositionOpen(positionId);
    return;
  }

  if (mode === 'confirm') {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'pending_confirmation');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'confirm_intent_created',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId },
    });
    await sendTradeIntent(intentId, freshSelectedRow.candidate, decision);
    return;
  }

  try {
    await executeLiveBuy(freshSelectedRow, decision, batchId, executionRows, triggerCandidateId);
  } catch (err) {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'execution_failed');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'live_entry_failed',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId, error: err.message },
    });
    await sendTelegram([
      '🛑 <b>Live trade failed</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Intent #${intentId} stored.`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}

export async function maybeProcessDegenCandidate(mint, trendingToken) {
  if (!boolSetting('trending_allow_degen', false)) return;
  const graduatedCoin = graduated.get(mint);
  if (!graduatedCoin) return;
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  const bucket = Math.floor(now() / (5 * 60 * 1000));
  const key = `graduated_trending:${mint}:${bucket}`;
  if (seenSignalCandidates.has(key)) return;
  seenSignalCandidates.set(key, now());
  await processCandidateFromSignals({
    mint,
    graduatedCoin,
    trendingToken,
    route: 'graduated_trending',
  });
}
