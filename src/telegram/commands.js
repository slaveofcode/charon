import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import { now, json } from '../utils.js';
import { escapeHtml, fmtPct } from '../format.js';
import { db } from '../db/connection.js';
import { numSetting, boolSetting, setSetting, activeStrategy, setActiveStrategy, strategyById, updateStrategyConfig } from '../db/settings.js';
import { candidateById, latestCandidateByMint, updateCandidateStatus } from '../db/candidates.js';
import { storeDecision, logDecisionEvent } from '../db/decisions.js';
import {
  menuKeyboard,
  filtersText,
  filtersKeyboard,
  agentText,
  agentKeyboard,
  navKeyboard,
  mainMenuText,
  walletsText,
  positionsText,
  candidateButtons,
  positionButtons,
  strategyMenuText,
  strategyKeyboard,
} from './menus.js';
import { sendTelegram, sendBatch, sendPositionOpen } from './send.js';
import { candidateSummary, formatPosition } from './format.js';
import { refreshPosition } from '../execution/positions.js';
import { executeLiveSell } from '../execution/router.js';
import { handleCallback, editMenuMessage } from './callbacks.js';
import { consumeNumericFilterInput } from './input.js';
import { runLearning, sendLessons } from '../learning/commands.js';
import { fetchWalletPnl } from '../enrichment/wallets.js';

export async function handleMessage(msg) {
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  if (await consumeNumericFilterInput(chatId, text, msg.message_id)) return;
  if (!text.startsWith('/')) return;
  if (text.startsWith('/close')) return handleClose(chatId, text);
  if (text.startsWith('/settp')) return handleSetTp(chatId, text);
  if (text.startsWith('/setsl')) return handleSetSl(chatId, text);
  if (text.startsWith('/menu')) return sendMenu(chatId);
  if (text.startsWith('/positions')) return sendPositions(chatId);
  if (text.startsWith('/filters')) return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  if (text.startsWith('/strategy')) {
    const parts = text.split(/\s+/);
    const id = parts[1];
    if (!id) {
      return bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
    }
    const valid = ['sniper', 'dip_buy', 'smart_money', 'degen'];
    if (!valid.includes(id)) {
      return bot.sendMessage(chatId, `Unknown strategy. Valid: ${valid.join(', ')}`);
    }
    setActiveStrategy(id);
    return bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
  }
  if (text.startsWith('/stratset')) {
    const parts = text.split(/\s+/);
    const [, id, key, ...rest] = parts;
    const value = rest.join(' ');
    if (!id || !key || !value) {
      return bot.sendMessage(chatId, 'Usage: /stratset <strategy_id> <key> <value>\\n\\nExample: /stratset sniper tp_percent 75\\n\\nKeys: tp_percent, sl_percent, position_size_sol, max_open_positions, min_mcap_usd, max_mcap_usd, min_holders, trailing_enabled, trailing_percent, partial_tp, partial_tp_at_percent, partial_tp_sell_percent, max_hold_ms, use_llm, llm_min_confidence, min_source_count, require_fee_claim, min_fee_claim_sol, min_gmgn_total_fee_sol, max_ath_distance_pct, max_bot_cluster_size, max_new_wallet_pct, max_dust_wallet_pct, max_uniform_pct, require_smart_wallet');
    }
    const strat = strategyById(id);
    if (!strat) return bot.sendMessage(chatId, `Strategy "${id}" not found.`);
    const numKeys = new Set(['tp_percent', 'sl_percent', 'position_size_sol', 'max_open_positions', 'min_mcap_usd', 'max_mcap_usd', 'min_holders', 'max_top20_holder_percent', 'trailing_percent', 'partial_tp_at_percent', 'partial_tp_sell_percent', 'max_hold_ms', 'llm_min_confidence', 'min_source_count', 'min_fee_claim_sol', 'min_gmgn_total_fee_sol', 'max_ath_distance_pct', 'token_age_max_ms', 'trending_min_volume_usd', 'trending_min_swaps', 'trending_max_rug_ratio', 'trending_max_bundler_rate', 'min_saved_wallet_holders', 'min_graduated_volume_usd', 'max_bot_cluster_size', 'max_new_wallet_pct', 'max_dust_wallet_pct', 'max_uniform_pct']);
    const boolKeys = new Set(['trailing_enabled', 'partial_tp', 'use_llm', 'require_fee_claim', 'require_smart_wallet']);
    const newConfig = { ...strat };
    delete newConfig.id;
    delete newConfig.name;
    if (numKeys.has(key)) {
      newConfig[key] = Number(value);
    } else if (boolKeys.has(key)) {
      newConfig[key] = value === 'true' || value === '1' || value === 'yes';
    } else {
      newConfig[key] = value;
    }
    updateStrategyConfig(id, newConfig);
    return bot.sendMessage(chatId, `Updated ${id}.${key} = ${value}\n\n${strategyMenuText()}`, { parse_mode: 'HTML' });
  }
  if (text.startsWith('/pnl')) return sendPnl(chatId);
  if (text.startsWith('/learn')) {
    const windowArg = text.split(/\s+/)[1] || '12h';
    return runLearning(chatId, windowArg);
  }
  if (text.startsWith('/lessons')) return sendLessons(chatId);
  if (text.startsWith('/candidate')) {
    const mint = text.split(/\s+/)[1];
    if (!mint) return bot.sendMessage(chatId, 'Usage: /candidate <mint>');
    const row = latestCandidateByMint(mint);
    if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
    return sendCandidate(chatId, row.id);
  }
  if (text.startsWith('/walletadd')) {
    const [, label, address] = text.split(/\s+/);
    if (!label || !address) return bot.sendMessage(chatId, 'Usage: /walletadd <label> <address>');
    db.prepare(`
      INSERT INTO saved_wallets (label, address, created_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(label) DO UPDATE SET address = excluded.address
    `).run(label, address, now());
    return bot.sendMessage(chatId, `Saved wallet ${label}.`);
  }
  if (text.startsWith('/walletremove')) {
    const label = text.split(/\s+/)[1];
    if (!label) return bot.sendMessage(chatId, 'Usage: /walletremove <label>');
    db.prepare('DELETE FROM saved_wallets WHERE label = ?').run(label);
    return bot.sendMessage(chatId, `Removed ${label}.`);
  }
  if (text.startsWith('/wallets')) return handleCallback({ id: 'manual', data: 'menu:wallets', message: { chat: { id: chatId } } });
  if (text.startsWith('/wallet ')) return handleWallet(chatId, text.slice(8).trim());
  if (text.startsWith('/whales ')) return handleWhales(chatId, text.slice(8).trim());
  if (text.startsWith('/tracked')) return handleTracked(chatId);
  if (text.startsWith('/setfilter')) {
    const { key, value } = parseSetFilter(text);
    const valid = new Set([
      'min_fee_claim_sol',
      'min_mcap_usd',
      'max_mcap_usd',
      'min_gmgn_total_fee_sol',
      'min_graduated_volume_usd',
      'max_top20_holder_percent',
      'min_saved_wallet_holders',
      'trending_enabled',
      'trending_source',
      'trending_allow_degen',
      'trending_interval',
      'trending_limit',
      'trending_order_by',
      'trending_min_volume_usd',
      'trending_min_swaps',
      'trending_max_rug_ratio',
      'trending_max_bundler_rate',
      'trading_mode',
      'llm_min_confidence',
      'llm_candidate_pick_count',
      'llm_candidate_max_age_ms',
      'max_open_positions',
      'dry_run_buy_sol',
      'default_tp_percent',
      'default_sl_percent',
      'default_trailing_enabled',
      'default_trailing_percent',
    ]);
    if (!valid.has(key) || value == null) {
      return bot.sendMessage(chatId, `Usage: /setfilter &lt;name&gt; &lt;value&gt;\n\n${filtersText()}`, { parse_mode: 'HTML' });
    }
    setSetting(key, value === 'off' ? '0' : value);
    return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  }
}

export async function sendCandidate(chatId, id) {
  const row = candidateById(id);
  if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
  const decision = db.prepare('SELECT * FROM llm_decisions WHERE candidate_id = ? ORDER BY id DESC LIMIT 1').get(id);
  await bot.sendMessage(chatId, candidateSummary(row.candidate, decision), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...candidateButtons(id, decision),
  });
}

export async function sendPositions(chatId) {
  const rows = allPositions(12);
  const text = rows.length ? rows.map(formatPosition).join('\n\n') : 'No dry-run positions yet.';
  await bot.sendMessage(chatId, `📍 <b>Positions</b>\n\n${text}`, { parse_mode: 'HTML', disable_web_page_preview: true });
}

export async function sendPosition(chatId, id, query = null) {
  let row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  if (row.status === 'open') {
    const refreshed = await refreshPosition(row, { autoExit: row.execution_mode !== 'live' }).catch((err) => {
      console.log(`[position] refresh ${id} ${err.message}`);
      return null;
    });
    if (refreshed) row = { ...row, ...refreshed };
  }
  const buttons = row.status === 'open' ? positionButtons(id) : {};
  if (query) return editMenuMessage(query, formatPosition(row), buttons);
  await bot.sendMessage(chatId, formatPosition(row), { parse_mode: 'HTML', disable_web_page_preview: true, ...buttons });
}

export async function closePosition(chatId, id, reason) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row || row.status !== 'open') return bot.sendMessage(chatId, 'Open position not found.');
  const result = await refreshPosition(row, { autoExit: false });
  const price = result?.price ?? row.high_water_price ?? row.entry_price;
  const mcap = result?.mcap ?? row.high_water_mcap ?? row.entry_mcap;
  const pnlPercent = row.entry_mcap ? (Number(mcap) / Number(row.entry_mcap) - 1) * 100 : 0;
  const pnlSol = Number(row.size_sol) * pnlPercent / 100;
  let sell = null;
  if (row.execution_mode === 'live') sell = await executeLiveSell(row, reason);
  db.prepare(`
    UPDATE dry_run_positions
    SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
        pnl_percent = ?, pnl_sol = ?, exit_signature = ?
    WHERE id = ?
  `).run(now(), price, mcap, reason, pnlPercent, pnlSol, sell?.signature || null, id);
  db.prepare(`
    INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
    VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, row.mint, now(), price, mcap, row.size_sol, row.token_amount_est, reason, json({ pnlPercent, pnlSol, sell }));
  const label = row.execution_mode === 'live' ? 'Closed live position' : 'Closed dry-run position';
  await bot.sendMessage(chatId, `${label} #${id}: ${escapeHtml(reason)} ${fmtPct(pnlPercent)}`, { parse_mode: 'HTML' });
}

export async function updatePositionRule(chatId, id, field, nextValue, query = null) {
  if (!Number.isFinite(nextValue)) return bot.sendMessage(chatId, 'Invalid value.');
  db.prepare(`UPDATE dry_run_positions SET ${field} = ? WHERE id = ?`).run(nextValue, id);
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (row) {
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(position_id) DO UPDATE SET
        tp_percent = excluded.tp_percent,
        sl_percent = excluded.sl_percent,
        trailing_enabled = excluded.trailing_enabled,
        trailing_percent = excluded.trailing_percent,
        updated_at_ms = excluded.updated_at_ms
    `).run(id, row.tp_percent, row.sl_percent, row.trailing_enabled, row.trailing_percent, now());
  }
  await sendPosition(chatId, id, query);
}

export async function toggleTrailing(chatId, id, query = null) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  const next = row.trailing_enabled ? 0 : 1;
  db.prepare('UPDATE dry_run_positions SET trailing_enabled = ? WHERE id = ?').run(next, id);
  db.prepare(`
    INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(position_id) DO UPDATE SET
      tp_percent = excluded.tp_percent,
      sl_percent = excluded.sl_percent,
      trailing_enabled = excluded.trailing_enabled,
      trailing_percent = excluded.trailing_percent,
      updated_at_ms = excluded.updated_at_ms
  `).run(id, row.tp_percent, row.sl_percent, next, row.trailing_percent, now());
  await sendPosition(chatId, id, query);
}

export function setupTelegram() {
  bot.setMyCommands([
    { command: 'menu', description: 'Open Charon menu' },
    { command: 'strategy', description: 'Show/switch strategy' },
    { command: 'stratset', description: 'Set strategy config (stratset id key value)' },
    { command: 'positions', description: 'Show dry-run positions' },
    { command: 'candidate', description: 'Show candidate by mint' },
    { command: 'filters', description: 'Show filters' },
    { command: 'pnl', description: 'Show saved-wallet PnL' },
    { command: 'learn', description: 'Run manual learning report' },
    { command: 'lessons', description: 'Show active screening lessons' },
    { command: 'setfilter', description: 'Set a filter value' },
    { command: 'walletadd', description: 'Save wallet for exposure/PnL' },
    { command: 'walletremove', description: 'Remove saved wallet' },
    { command: 'wallets', description: 'List saved wallets' },
    { command: 'close', description: 'Close position by id (/close 2)' },
    { command: 'settp', description: 'Set TP percent (/settp 2 75)' },
    { command: 'setsl', description: 'Set SL percent (/setsl 2 -40)' },
  ]).catch(err => console.log(`[telegram] commands ${err.message}`));

  bot.on('callback_query', query => handleCallback(query).catch(err => console.log(`[callback] ${err.message}`)));
  bot.on('message', msg => handleMessage(msg).catch(err => console.log(`[message] ${err.message}`)));
  bot.on('polling_error', err => console.log(`[telegram] polling ${err.message}`));
}

async function handleClose(chatId, text) {
  const parts = text.split(/\s+/);
  const id = Number(parts[1]);
  if (!id) return bot.sendMessage(chatId, 'Usage: /close <id>');
  return closePosition(chatId, id, 'MANUAL_CLOSE');
}

async function handleSetTp(chatId, text) {
  const parts = text.split(/\s+/);
  const id = Number(parts[1]);
  const pct = Number(parts[2]);
  if (!id || !Number.isFinite(pct)) return bot.sendMessage(chatId, 'Usage: /settp <id> <percent>\n\nExample: /settp 2 75');
  return updatePositionRule(chatId, id, 'tp_percent', Math.abs(pct));
}

async function handleSetSl(chatId, text) {
  const parts = text.split(/\s+/);
  const id = Number(parts[1]);
  const pct = Number(parts[2]);
  if (!id || !Number.isFinite(pct)) return bot.sendMessage(chatId, 'Usage: /setsl <id> <percent>\n\nExample: /setsl 2 -40');
  return updatePositionRule(chatId, id, 'sl_percent', pct);
}

async function sendMenu(chatId = TELEGRAM_CHAT_ID) {
  const { TELEGRAM_TOPIC_ID } = await import('../config.js');
  await bot.sendMessage(chatId, mainMenuText(), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...menuKeyboard(),
  });
}

async function sendPnl(chatId, query = null) {
  const wallets = savedWallets();
  if (!wallets.length) {
    const text = '📊 <b>PnL</b>\n\nNo saved wallets. Use /walletadd &lt;label&gt; &lt;address&gt;.';
    return query ? editMenuMessage(query, text, navKeyboard()) : bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  }
  const chunks = [];
  for (const wallet of wallets) {
    const pnl = await fetchWalletPnl(wallet.address).catch(() => null);
    if (!pnl) {
      chunks.push(`• <b>${escapeHtml(wallet.label)}</b>: no data`);
      continue;
    }
    chunks.push([
      `• <b>${escapeHtml(wallet.label)}</b>`,
      `Win: ${fmtPct(pnl.winRate)} · PnL: ${fmtPct(pnl.totalPnlPercent)}`,
      `Trades: ${pnl.totalTrades} · Wins: ${pnl.wins}`,
    ].join('\n'));
  }
  const text = `📊 <b>PnL</b>\n\n${chunks.join('\n\n')}`;
  return query ? editMenuMessage(query, text, navKeyboard()) : bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

/**
 * /wallet <address> — Show wallet profile (SOL balance, age, tokens, tracking)
 */
async function handleWallet(chatId, address) {
  if (!address || address.length < 32) {
    return bot.sendMessage(chatId, 'Usage: /wallet <solana_address>');
  }

  try {
    const { walletRiskProfile, walletAgeMs, walletDistinctTokensHeld } = await import('../analysis/walletProfile.js');
    const { getWalletByAddress, getObservationsByWallet } = await import('../analysis/walletTracker.js');

    const profile = await walletRiskProfile(address);
    const obs = getObservationsByWallet(address, 5);
    const tracking = getWalletByAddress(address);

    const lines = [`👤 <b>Wallet: ${escapeHtml(address.slice(0, 8))}...${escapeHtml(address.slice(-4))}</b>`];
    lines.push('');
    lines.push(`💰 SOL: <b>${profile.solBalance?.toFixed(4) || '?'} SOL</b>`);
    lines.push(`⏰ Age: <b>${profile.ageHours != null ? profile.ageHours.toFixed(1) + 'h' : 'unknown'}</b>`);
    lines.push(`🏷️ Tokens: <b>${profile.distinctTokens ?? '?'}</b>`);
    lines.push(`📋 Tags: ${profile.tags?.length ? profile.tags.map(t => '#' + t).join(', ') : 'none'}`);

    if (tracking) {
      const winRate = tracking.total_calls > 0
        ? (tracking.profitable_calls / tracking.total_calls * 100).toFixed(0)
        : '?';
      lines.push('');
      lines.push(`📊 <b>Tracked Stats</b>`);
      lines.push(`Calls: ${tracking.total_calls} · Wins: ${tracking.profitable_calls}`);
      lines.push(`Win Rate: <b>${winRate}%</b> · Avg PnL: ${tracking.total_observed_pnl_percent?.toFixed(1) || '0'}%`);
      lines.push(`Bot Flag: ${tracking.is_bot_flag ? '🚨 YES' : '✅ No'}`);
      if (tracking.tags) {
        const tTags = JSON.parse(tracking.tags || '[]');
        if (tTags.length) lines.push(`Tags: ${tTags.map(t => '#' + t).join(', ')}`);
      }
    }

    if (obs.length) {
      lines.push('');
      lines.push(`📝 <b>Recent Observations</b>`);
      for (const o of obs.slice(0, 3)) {
        const symbol = o.mint.slice(0, 8);
        const pnl = o.pnl_percent != null ? ` · ${o.pnl_percent >= 0 ? '+' : ''}${o.pnl_percent.toFixed(1)}%` : '';
        lines.push(`• ${escapeHtml(symbol)}...${pnl}`);
      }
    }

    return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  } catch (err) {
    return bot.sendMessage(chatId, `Error fetching wallet: ${escapeHtml(err.message)}`);
  }
}

/**
 * /whales <mint> — Show top 10 holders with wallet analysis
 */
async function handleWhales(chatId, mint) {
  if (!mint) return bot.sendMessage(chatId, 'Usage: /whales <mint_address>');

  try {
    const { fetchJupiterHolders } = await import('../enrichment/jupiter.js');
    const { analyzeWalletLayer } = await import('../analysis/analyzeCandidate.js');
    const { walletRiskProfile } = await import('../analysis/walletProfile.js');

    const holders = await fetchJupiterHolders(mint);
    if (!holders?.holders?.length) return bot.sendMessage(chatId, 'No holder data found for this mint.');

    const candidate = { token: { mint }, holders };
    const analysis = await analyzeWalletLayer(candidate);

    const lines = [`🐋 <b>Whale Analysis: ${escapeHtml(mint.slice(0, 8))}...</b>`];
    lines.push('');

    // Scores
    if (analysis.passed === false) {
      lines.push(`🚨 <b>Filtered!</b> ${analysis.failures.join('; ')}`);
      lines.push('');
    }
    lines.push(`📊 <b>Scores</b>`);
    lines.push(`New wallets: ${analysis.scores.newWalletPct}% · Dust: ${analysis.scores.dustWalletPct}%`);
    lines.push(`Cluster: ${analysis.scores.clusterLevel} (${analysis.scores.maxClusterSize} wallets)`);
    lines.push(`Pattern: ${analysis.scores.patternScore.toFixed(0)}/100 · Smart wallets: ${analysis.scores.provenWalletCount}`);
    lines.push('');

    // Top 5 holders
    lines.push(`👥 <b>Top 5 Holders</b>`);
    const profiles = analysis.details.profiles?.slice(0, 5) || [];
    for (let i = 0; i < Math.min(5, holders.holders.length); i++) {
      const h = holders.holders[i];
      const p = profiles.find(pf => h.address.startsWith(pf.address.split('...')[0])) || {};
      const tagStr = p.tags?.length ? ` [${p.tags.join(',')}]` : '';
      const pct = h.percent != null ? `${h.percent.toFixed(1)}%` : '?%';
      lines.push(`${i + 1}. <a href="https://solscan.io/account/${h.address}">${escapeHtml(h.address.slice(0, 8))}...</a> ${pct}${tagStr}`);
    }

    // Tokens they hold
    lines.push('');
    lines.push(`Total holders: ${holders.count}`);
    lines.push(`Top 20 hold: ${holders.top20Percent?.toFixed(1) || '?'}%`);

    return bot.sendMessage(chatId, lines.join('\n'), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    return bot.sendMessage(chatId, `Error: ${escapeHtml(err.message)}`);
  }
}

/**
 * /tracked — List tracked smart wallets
 */
async function handleTracked(chatId) {
  try {
    const { getProvenWallets, getWalletByAddress } = await import('../analysis/walletTracker.js');
    const proven = getProvenWallets();
    const allWallets = db.prepare('SELECT * FROM wallet_tracking ORDER BY total_calls DESC LIMIT 20').all();

    if (!allWallets.length) {
      return bot.sendMessage(chatId, '📭 No wallets tracked yet. Wallets are tracked automatically as candidate tokens are analyzed.');
    }

    const lines = ['📋 <b>Tracked Wallets</b>'];
    lines.push('');

    if (proven.length) {
      lines.push(`⭐ <b>Proven Smart Wallets (${proven.length})</b>`);
      for (const w of proven.slice(0, 10)) {
        const wr = w.total_calls > 0 ? (w.profitable_calls / w.total_calls * 100).toFixed(0) : '?';
        lines.push(`• <a href="https://solscan.io/account/${w.address}">${escapeHtml(w.address.slice(0, 8))}...</a> <b>${wr}%</b> win (${w.total_calls} calls, ${w.profitable_calls} wins)`);
      }
      lines.push('');
    }

    lines.push(`📊 <b>All Tracked</b>`);
    for (const w of allWallets) {
      const wr = w.total_calls > 0 ? (w.profitable_calls / w.total_calls * 100).toFixed(0) : '?';
      const tags = JSON.parse(w.tags || '[]');
      const tagStr = tags.length ? ` [${tags.join(',')}]` : '';
      const botStr = w.is_bot_flag ? ' 🚨' : '';
      lines.push(`• <a href="https://solscan.io/account/${w.address}">${escapeHtml(w.address.slice(0, 8))}...</a> ${wr}%${botStr}${tagStr}`);
    }

    return bot.sendMessage(chatId, lines.join('\n'), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    return bot.sendMessage(chatId, `Error: ${escapeHtml(err.message)}`);
  }
}

function parseSetFilter(text) {
  const parts = text.trim().split(/\s+/);
  return { key: parts[1], value: parts[2] };
}

function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

function savedWallets() {
  return db.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
}
