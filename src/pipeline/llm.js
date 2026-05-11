import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { now, stripThinking, strictJsonFromText } from '../utils.js';
import { numSetting } from '../db/settings.js';
import { db } from '../db/connection.js';

export function normalizeDecision(parsed, fallbackReason = '') {
  const verdict = ['BUY', 'WATCH', 'PASS'].includes(String(parsed?.verdict).toUpperCase())
    ? String(parsed.verdict).toUpperCase()
    : 'WATCH';
  return {
    verdict,
    confidence: Math.max(0, Math.min(100, Number(parsed?.confidence) || 0)),
    reason: String(parsed?.reason || fallbackReason).slice(0, 1000),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    suggested_tp_percent: Number(parsed?.suggested_tp_percent) || numSetting('default_tp_percent', 50),
    suggested_sl_percent: Number(parsed?.suggested_sl_percent) || numSetting('default_sl_percent', -25),
    raw: parsed,
  };
}

export function activeLessonsForPrompt(limit = 6) {
  return db.prepare(`
    SELECT lesson
    FROM learning_lessons
    WHERE status = 'active'
    ORDER BY id DESC
    LIMIT ?
  `).all(limit).map(row => row.lesson);
}

export function compactCandidateForLlm(row) {
  const c = row.candidate;
  const athWindow = c.chart?.windows?.find(window => window.label === 'ath_context_24h_5m' && window.available)
    || c.chart?.windows?.find(window => window.label === 'recent_24h_5m' && window.available);
  return {
    candidate_id: row.id,
    mint: c.token?.mint,
    route: c.signals?.route,
    signals: c.signals,
    token: c.token,
    metrics: c.metrics,
    feeClaim: c.feeClaim,
    trending: c.trending,
    graduation: c.graduation,
    holders: c.holders,
    chart: {
      purpose: 'ATH/range context only. Do not treat large 24h change as bullish/bearish momentum by itself.',
      currentNative: c.chart?.currentNative,
      rangeHighNative: c.chart?.rangeHighNative,
      distanceFromAthPercent: c.chart?.distanceFromAthPercent ?? c.chart?.belowRangeHighPercent,
      topBlastRisk: c.chart?.topBlastRisk,
      athContext24h: athWindow ? {
        current: athWindow.current,
        high: athWindow.high,
        low: athWindow.low,
        distanceFromHighPercent: athWindow.belowHighPercent,
        aboveLowPercent: athWindow.aboveLowPercent,
      } : null,
      windows: c.chart?.windows,
    },
    savedWalletExposure: c.savedWalletExposure,
    twitterNarrative: c.twitterNarrative,
    filters: c.filters,
  };
}

export async function decideCandidateBatch(rows, triggerCandidateId) {
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: 'LLM disabled or LLM_API_KEY missing.',
      risks: ['no_llm_decision'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: null,
    };
  }

  const system = [
    'You are Charon, a Solana meme coin trench analyst.',
    'Return strict JSON only.',
    'You will receive up to 10 recently matched candidates.',
    'Pick at most one candidate to buy through the configured execution mode.',
    'Use verdict BUY only for the single best unusually strong asymmetric opportunity.',
    'Use WATCH if candidates are interesting but none deserves a buy.',
    'Use PASS if the set is weak or unsafe.',
    'Chart data is ATH/range context. Do not penalize or reward a token only because 24h change is huge; new Pump tokens often do that.',
    'Use distance from ATH/range high and top-blast risk to decide whether entry is late.',
    'Confidence is your conviction from 0 to 100, not probability.',
  ].join(' ');
  const user = {
    task: 'Pick the best dry-run buy candidate from this recent batch, or choose none.',
    recent_lessons: activeLessonsForPrompt(),
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: 'mint string when verdict is BUY, otherwise null',
      confidence: 'number 0-100',
      reason: 'short string',
      risks: ['short strings'],
      suggested_tp_percent: 'positive number',
      suggested_sl_percent: 'negative number',
    },
    trigger_candidate_id: triggerCandidateId,
    candidates: rows.map(compactCandidateForLlm),
  };

  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const content = res.data?.choices?.[0]?.message?.content || '';
    const parsed = strictJsonFromText(content);
    const decision = normalizeDecision(parsed);
    const selectedId = Number(parsed.selected_candidate_id);
    const selectedMint = String(parsed.selected_mint || '');
    const row = rows.find(item => item.id === selectedId || item.candidate.token?.mint === selectedMint);
    return {
      ...decision,
      selected_candidate_id: decision.verdict === 'BUY' && row ? row.id : null,
      selected_mint: decision.verdict === 'BUY' && row ? row.candidate.token.mint : null,
      selected_row: decision.verdict === 'BUY' && row ? row : null,
    };
  } catch (err) {
    console.log(`[llm] batch failed: ${err.message}`);
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `LLM failed: ${err.message}`,
      risks: ['llm_error'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: { error: err.message },
    };
  }
}

export async function decideCandidate(candidate) {
  const pseudoRow = { id: 0, candidate };
  const decision = await decideCandidateBatch([pseudoRow], 0);
  return normalizeDecision(decision.raw || decision, decision.reason);
}

/**
 * LLM decision: should a position that's been open for a while with modest profit 
 * be closed to free up capital, or held for more upside?
 * Called when a position has been open > timeExitCheckMin but PnL < TP.
 * @param {Object} position - row from dry_run_positions
 * @param {Object} asset - Jupiter asset data (mcap, price, volume, holders)
 * @param {Object} [extra={}] - gmgn, chart, trending data for richer context
 */
export async function decideTimeExit(position, asset, extra = {}) {
  if (!ENABLE_LLM || !LLM_API_KEY) return 'HOLD';

  const ageMin = (now() - position.opened_at_ms) / 60000;
  const pnlPercent = position.high_water_mcap && position.entry_mcap
    ? ((Number(position.high_water_mcap) / Number(position.entry_mcap)) - 1) * 100
    : 0;
  // current mcap/price from asset
  const currentMcap = Number(asset?.mcap || 0);
  const currentPrice = Number(asset?.usdPrice || 0);
  const currentPnl = position.entry_mcap && currentMcap
    ? ((currentMcap / Number(position.entry_mcap)) - 1) * 100
    : pnlPercent;

  const system = [
    'You are Charon, a Solana meme coin position manager.',
    'You have 1 open position that is aging. The market moves fast — capital needs to rotate.',
    'Return STRICT JSON only. No markdown, no explanation outside JSON.',
  ].join(' ');

  const user = {
    task: 'Decide whether to CLOSE or HOLD this open position. It has been open for a while and has modest unrealized profit but has NOT hit its TP target yet. Closing frees capital for fresh setups; holding may bring more gains or a drawdown.',
    position: {
      id: position.id,
      mint: position.mint,
      symbol: position.symbol || position.mint.slice(0, 8),
      age_minutes: Math.round(ageMin),
      entry_mcap: Number(position.entry_mcap),
      high_water_mcap: Number(position.high_water_mcap || 0),
      current_mcap: currentMcap || Number(position.high_water_mcap || position.entry_mcap || 0),
      current_pnl_percent: Math.round(currentPnl * 100) / 100,
      high_water_pnl_percent: Math.round(pnlPercent * 100) / 100,
      tp_percent: Number(position.tp_percent),
      sl_percent: Number(position.sl_percent),
      size_sol: Number(position.size_sol),
      trailing_enabled: Boolean(position.trailing_enabled),
    },
    token_data: extra.gmgn ? {
      name: extra.gmgn.name,
      symbol: extra.gmgn.symbol,
      price: extra.gmgn.price_usd,
      liquidity: extra.gmgn.liquidity,
      holder_count: extra.gmgn.holder_count,
      volume_24h: extra.gmgn.volume_24h_usd,
      total_fee_sol: extra.gmgn.total_fee,
      trade_fee_sol: extra.gmgn.trade_fee,
      top_10_holder_percent: extra.gmgn.top_10_holder_rate,
      cto: extra.gmgn.cto,
      twitter_followers: extra.gmgn.twitter_followers,
      rug_ratio: extra.gmgn.rug_ratio,
      bundler_rate: extra.gmgn.bundler_rate,
    } : null,
    market_context: extra.chart?.windows ? {
      windows: extra.chart.windows.slice(0, 3).map(w => ({
        label: w.label,
        current: w.current,
        high: w.high,
        low: w.low,
        available: w.available,
      })),
    } : null,
    trending: extra.trending ? {
      rank: extra.trending.rank,
      volume: extra.trending.volume,
      swaps: extra.trending.swaps,
      hot_level: extra.trending.hot_level,
    } : null,
    output_schema: {
      action: '"CLOSE" or "HOLD"',
      reason: 'one short sentence explaining why',
      confidence: 'number 0-100',
    },
  };

  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const content = res.data?.choices?.[0]?.message?.content || '';
    const parsed = strictJsonFromText(content);
    const action = String(parsed?.action || '').toUpperCase() === 'CLOSE' ? 'CLOSE' : 'HOLD';
    console.log(`[timeExit] #${position.id} ${position.mint.slice(0, 8)}... age:${Math.round(ageMin)}m pnl:${currentPnl.toFixed(1)}% → ${action} (reason: ${parsed?.reason || ''})`);
    return action;
  } catch (err) {
    console.log(`[timeExit] #${position.id} LLM failed: ${err.message}`);
    return 'HOLD';
  }
}
