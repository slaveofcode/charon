/**
 * Cluster detection via funding source analysis.
 *
 * Identifies bot wallet clusters by tracing the earliest inbound SOL transfer
 * for each top holder, then grouping wallets that share a common funding source.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { SOLANA_RPC_URL } from '../config.js';
import { walletCache } from '../enrichment/rpcCache.js';

// --- Overridable for tests ---
let _testConnection = null;
let _testGetTransaction = null;
let _testGetSignaturesForAddress = null;

export function setTestConnection(mock) {
  _testConnection = mock;
}

export function setTestGetTransaction(mockFn) {
  _testGetTransaction = mockFn;
}

export function setTestGetSignaturesForAddress(mockFn) {
  _testGetSignaturesForAddress = mockFn;
}

/** TTL for funding source cache — 30 minutes (funding rarely changes) */
const FUNDING_CACHE_TTL = 30 * 60 * 1000;

/**
 * Build the connection object, respecting test overrides.
 */
function getConnection() {
  if (_testConnection) return _testConnection;
  return new Connection(SOLANA_RPC_URL, 'confirmed');
}

/**
 * For each address in the top 10 holders, trace the earliest inbound SOL
 * transfer and return a map of source address → wallet addresses[].
 *
 * @param {Array<{address: string, rank: number, amount: number, percent: number|null, tags: string[]}>} holders
 * @returns {Promise<Map<string, string[]>>}
 */
export async function findFundingSources(holders) {
  if (!holders || !holders.length) return new Map();

  const top = holders.slice(0, 10);
  const connection = getConnection();

  /** @type {Map<string, string[]>} */
  const sourceToWallets = new Map();

  for (const holder of top) {
    const address = holder.address;
    if (!address) continue;

    const cacheKey = `funding:${address}`;
    const cached = walletCache.get(cacheKey);
    if (cached !== null) {
      if (cached) {
        const list = sourceToWallets.get(cached) || [];
        list.push(address);
        sourceToWallets.set(cached, list);
      }
      continue;
    }

    try {
      const pk = new PublicKey(address);
      const source = await traceEarliestSender(connection, pk);
      if (source) {
        walletCache.set(cacheKey, source, FUNDING_CACHE_TTL);
        const list = sourceToWallets.get(source) || [];
        list.push(address);
        sourceToWallets.set(source, list);
      } else {
        // Mark as traced-but-no-source-found (null value, not cached as empty string)
        walletCache.set(cacheKey, '', FUNDING_CACHE_TTL);
      }
    } catch {
      // Silently skip — RPC limits, new wallets, etc.
    }
  }

  return sourceToWallets;
}

/**
 * Trace the earliest inbound SOL transfer for a given public key.
 *
 * Fetches recent signatures, then iterates transactions to find the first one
 * where the target address received SOL (postBalance > preBalance).
 *
 * @param {Connection} connection
 * @param {PublicKey} pubkey
 * @returns {Promise<string|null>} sender address, or null if not found
 */
async function traceEarliestSender(connection, pubkey) {
  let signatures;
  if (_testGetSignaturesForAddress) {
    signatures = _testGetSignaturesForAddress(pubkey.toBase58());
  } else {
    signatures = await connection.getSignaturesForAddress(pubkey, { limit: 5 });
  }

  if (!signatures || signatures.length === 0) return null;

  for (const sigInfo of signatures) {
    let tx;
    if (_testGetTransaction) {
      tx = _testGetTransaction(sigInfo.signature);
    } else {
      tx = await connection.getTransaction(sigInfo.signature, {
        maxSupportedTransactionVersion: 0,
      });
    }

    if (!tx) continue;

    const sender = extractSenderIfReceived(tx, pubkey.toBase58());
    if (sender) return sender;
  }

  return null;
}

/**
 * Given a parsed transaction, determine if the target address received SOL.
 * If yes, return the sender address.
 *
 * @param {any} tx - parsed transaction from getTransaction
 * @param {string} targetAddress - base58 of the target wallet
 * @returns {string|null}
 */
function extractSenderIfReceived(tx, targetAddress) {
  const accountKeys = tx.transaction?.message?.accountKeys;
  const preBalances = tx.meta?.preBalances;
  const postBalances = tx.meta?.postBalances;

  if (!accountKeys || !preBalances || !postBalances) return null;
  if (accountKeys.length !== preBalances.length || accountKeys.length !== postBalances.length) return null;

  let targetIndex = -1;
  let preBalance = 0;
  let postBalance = 0;

  for (let i = 0; i < accountKeys.length; i++) {
    const key = typeof accountKeys[i] === 'string' ? accountKeys[i] : accountKeys[i]?.toBase58();
    if (key === targetAddress) {
      targetIndex = i;
      preBalance = preBalances[i];
      postBalance = postBalances[i];
      break;
    }
  }

  if (targetIndex === -1) return null;

  // Did the target receive SOL?
  if (postBalance <= preBalance) return null;

  // Find the sender: look for an account that lost SOL in this tx
  // The fee payer is typically the first account, but we want the actual sender
  for (let i = 0; i < accountKeys.length; i++) {
    if (i === targetIndex) continue;
    // A sender's balance decreased (fees + transfer amount)
    if (preBalances[i] > postBalances[i]) {
      const key = typeof accountKeys[i] === 'string' ? accountKeys[i] : accountKeys[i]?.toBase58();
      if (key) return key;
    }
  }

  return null;
}

/**
 * Analyze holders for wallet clusters.
 *
 * @param {Array<{address: string, rank: number, amount: number, percent: number|null, tags: string[]}>} holders
 * @returns {Promise<{
 *   clusterFound: boolean,
 *   totalChecked: number,
 *   maxClusterSize: number,
 *   clusterCount: number,
 *   clusters: Array<{source: string, wallets: string[], count: number}>,
 *   score: number,
 *   level: 'none' | 'cluster' | 'bot_army',
 * }>}
 */
export async function detectClusters(holders) {
  const sourceToWallets = await findFundingSources(holders);

  const clusters = [];
  let totalChecked = 0;

  for (const [source, wallets] of sourceToWallets) {
    const count = wallets.length;
    totalChecked += count;
    // Only report as a cluster if >= 2 wallets share the source
    if (count >= 2) {
      clusters.push({ source, wallets, count });
    }
  }

  const maxClusterSize = clusters.length > 0
    ? Math.max(...clusters.map(c => c.count))
    : 0;

  const clusterCount = clusters.length;

  const score = totalChecked > 0
    ? Math.round((maxClusterSize / totalChecked) * 100)
    : 0;

  let level = 'none';
  if (maxClusterSize >= 5) {
    level = 'bot_army';
  } else if (maxClusterSize >= 3) {
    level = 'cluster';
  }

  return {
    clusterFound: maxClusterSize >= 3,
    totalChecked,
    maxClusterSize,
    clusterCount,
    clusters,
    score,
    level,
  };
}
