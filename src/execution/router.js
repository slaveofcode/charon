import { now, json } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { WSOL_MINT, LIVE_MIN_SOL_RESERVE_LAMPORTS, JUPITER_SWAP_BASE_URL, JSON_HEADERS, JUPITER_API_KEY } from '../config.js';
import { escapeHtml, fmtSol } from '../format.js';
import { executeJupiterSwap, liveWalletBalanceLamports, fetchLiveTokenBalance } from '../liveExecutor.js';
import { activeStrategy } from '../db/settings.js';
import { createLivePosition, canOpenMorePositions, openPositionCount } from '../db/positions.js';
import { intentById } from '../db/intents.js';
import { logDecisionEvent } from '../db/decisions.js';
import { refreshCandidateForExecution } from './positions.js';
import { bot } from '../telegram/bot.js';
import { candidateSummary } from '../telegram/format.js';
import { sendPositionOpen, sendTelegram } from '../telegram/send.js';
import { updateCandidateStatus } from '../db/candidates.js';
import { createTradeIntent } from '../db/intents.js';
import axios from 'axios';

/**
 * Check if a token can be sold (honeypot detection).
 * Uses persistent cache to avoid re-checking known honeypots.
 * Tries to get a Jupiter sell quote — if no route exists, likely a honeypot.
 * Returns { safe: true } if sell route exists, { safe: false, reason } otherwise.
 */
async function checkHoneypot(tokenMint, symbol) {
  // Check persistent cache first
  const cached = db.prepare('SELECT reason, hit_count FROM honeypot_cache WHERE mint = ?').get(tokenMint);
  if (cached) {
    db.prepare('UPDATE honeypot_cache SET hit_count = hit_count + 1 WHERE mint = ?').run(tokenMint);
    console.log(`[honeypot] ${symbol} ${tokenMint.slice(0, 8)}... CACHED (${cached.hit_count + 1}x) — ${cached.reason}`);
    return { safe: false, reason: cached.reason };
  }

  try {
    const url = new URL(`${JUPITER_SWAP_BASE_URL.replace(/\/$/, '')}/quote`);
    url.searchParams.set('inputMint', tokenMint);
    url.searchParams.set('outputMint', WSOL_MINT);
    url.searchParams.set('amount', '1000'); // tiny amount raw units
    url.searchParams.set('slippageBps', '300');
    const res = await axios.get(url.toString(), {
      timeout: 10_000,
      headers: { ...JSON_HEADERS, 'x-api-key': JUPITER_API_KEY },
    });
    const quote = res.data;
    if (!quote || !quote.outAmount || Number(quote.outAmount) <= 0) {
      return { safe: false, reason: 'Jupiter returned zero output for sell route' };
    }
    if (quote.routePlan && quote.routePlan.length === 0) {
      return { safe: false, reason: 'Jupiter found no sell route (routePlan empty)' };
    }
    console.log(`[honeypot] ${symbol} ${tokenMint.slice(0, 8)}... SAFE (sell route exists, outAmount: ${quote.outAmount})`);
    return { safe: true };
  } catch (err) {
    const msg = err.response?.data?.error || err.message || 'unknown error';
    const isNoRoute = msg.toLowerCase().includes('no route') || msg.toLowerCase().includes('no pool');
    const reason = isNoRoute
      ? `No sell route — potential honeypot: ${msg}`
      : `Sell quote failed: ${msg}`;
    // Cache flagged tokens to avoid re-checking
    try {
      db.prepare('INSERT OR IGNORE INTO honeypot_cache (mint, reason, created_at_ms) VALUES (?, ?, ?)').run(tokenMint, reason, Date.now());
    } catch { /* cache non-critical */ }
    console.log(`[honeypot] ${symbol} ${tokenMint.slice(0, 8)}... CACHED — ${reason}`);
    return { safe: false, reason };
  }
}

export async function executeLiveBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const strat = activeStrategy();
  const amountLamports = Math.floor((strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1)) * 1_000_000_000);
  const balance = await liveWalletBalanceLamports();
  if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
    throw new Error(`Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL including reserve.`);
  }
  // Honeypot check: verify sell route exists before buying
  const hp = await checkHoneypot(selectedRow.candidate.token.mint, selectedRow.candidate.token.symbol);
  if (!hp.safe) {
    await sendTelegram([
      `🚨 <b>Honeypot blocked</b>`,
      `Token: <a href="https://gmgn.ai/sol/token/${selectedRow.candidate.token.mint}">${escapeHtml(selectedRow.candidate.token.symbol || '?')}</a> (${selectedRow.candidate.token.mint.slice(0, 8)}...)`,
      `Reason: ${escapeHtml(hp.reason)}`,
    ].join('\n')).catch(() => {});
    throw new Error(`Honeypot check failed: ${hp.reason}`);
  }
  const swap = await executeJupiterSwap({
    inputMint: WSOL_MINT,
    outputMint: selectedRow.candidate.token.mint,
    amount: amountLamports,
  });
  if (!swap.outputAmount) {
    swap.outputAmount = await fetchLiveTokenBalance(selectedRow.candidate.token.mint) || swap.outputAmount;
  }
  const positionId = createLivePosition(selectedRow.id, selectedRow.candidate, decision, swap, `live_batch_${batchId}`);
  logDecisionEvent({
    batchId,
    triggerCandidateId,
    selectedRow,
    rows,
    decision,
    mode: 'live',
    action: 'live_entry_executed',
    guardrails: { balanceLamports: balance, amountLamports, minReserveLamports: LIVE_MIN_SOL_RESERVE_LAMPORTS },
    execution: { positionId, swap },
  });
  await sendPositionOpen(positionId);
}

export async function executeLiveSell(position, reason) {
  const amount = position.token_amount_raw || position.token_amount_est;
  if (!amount || Number(amount) <= 0) throw new Error('Live position has no token amount to sell.');
  return executeJupiterSwap({
    inputMint: position.mint,
    outputMint: WSOL_MINT,
    amount,
  });
}

export async function executeConfirmedIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent || intent.status !== 'pending_confirmation') return bot.sendMessage(chatId, 'Pending intent not found.');
  if (!canOpenMorePositions()) {
    return bot.sendMessage(chatId, `Max open positions reached (${openPositionCount()}/${numSetting('max_open_positions', 3)}).`);
  }
  const { decision } = intent.payload;
  try {
    const freshRow = await refreshCandidateForExecution({
      id: intent.candidate_id,
      candidate: intent.payload.candidate,
    });
    if (!freshRow.candidate.filters?.passed) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_stale', now(), intentId);
      return bot.sendMessage(chatId, [
        '🛑 <b>Trade intent rejected on fresh check</b>',
        '',
        candidateSummary(freshRow.candidate, decision),
        '',
        `Failures: ${escapeHtml((freshRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
      ].join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
    }
    const strat = activeStrategy();
    const amountLamports = Math.floor((strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1)) * 1_000_000_000);
    const balance = await liveWalletBalanceLamports();
    if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_insufficient_balance', now(), intentId);
      return bot.sendMessage(chatId, `Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL.`, { parse_mode: 'HTML' });
    }
    // Honeypot check
    const hp = await checkHoneypot(freshRow.candidate.token.mint, freshRow.candidate.token.symbol);
    if (!hp.safe) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_honeypot', now(), intentId);
      return bot.sendMessage(chatId, [
        '🚨 <b>Honeypot blocked</b>',
        `Token: <a href="https://gmgn.ai/sol/token/${freshRow.candidate.token.mint}">${escapeHtml(freshRow.candidate.token.symbol || '?')}</a> (${freshRow.candidate.token.mint.slice(0, 8)}...)`,
        `Reason: ${escapeHtml(hp.reason)}`,
      ].join('\n'), { parse_mode: 'HTML' });
    }
    const swap = await executeJupiterSwap({
      inputMint: WSOL_MINT,
      outputMint: freshRow.candidate.token.mint,
      amount: amountLamports,
    });
    if (!swap.outputAmount) {
      swap.outputAmount = await fetchLiveTokenBalance(freshRow.candidate.token.mint) || swap.outputAmount;
    }
    const positionId = createLivePosition(intent.candidate_id, freshRow.candidate, decision, swap, `confirmed_intent_${intentId}`);
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('executed_live', now(), intentId);
    logDecisionEvent({
      batchId: null,
      triggerCandidateId: intent.candidate_id,
      selectedRow: freshRow,
      rows: [],
      decision,
      mode: 'live',
      action: 'confirmed_intent_executed',
      guardrails: { balanceLamports: balance, amountLamports, intentId },
      execution: { positionId, swap },
    });
    return sendPositionOpen(positionId);
  } catch (err) {
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('execution_failed', now(), intentId);
    return bot.sendMessage(chatId, `Live execution failed: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
}

export async function rejectIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent) return bot.sendMessage(chatId, 'Intent not found.');
  db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected', now(), intentId);
  return bot.sendMessage(chatId, `Rejected trade intent #${intentId}.`);
}
