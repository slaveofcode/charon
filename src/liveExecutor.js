import axios from 'axios';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  JUPITER_API_KEY,
  JUPITER_SLIPPAGE_BPS,
  JUPITER_SWAP_BASE_URL,
  JSON_HEADERS,
  SOLANA_PRIVATE_KEY,
  SOLANA_RPC_URL,
} from './config.js';
import { now } from './utils.js';

let liveWallet = null;
let solanaConnection = null;
let cachedBalance = null;

// Multi-key RPC rotation
let rpcKeyIndex = 0;
function getRpcUrls() {
  const keys = (process.env.HELIUS_API_KEY || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);
  if (!keys.length) return [SOLANA_RPC_URL, 'https://api.mainnet-beta.solana.com'];
  const urls = keys.map(key => `https://mainnet.helius-rpc.com/?api-key=${key}`);
  urls.push('https://api.mainnet-beta.solana.com'); // final fallback
  return urls;
}
function nextRpcUrl() {
  const urls = getRpcUrls();
  const url = urls[rpcKeyIndex % urls.length];
  rpcKeyIndex++;
  return url;
}

function getRotatedConnection() {
  const url = nextRpcUrl();
  return new Connection(url, 'confirmed');
}

function parseKeypair(secret) {
  const value = String(secret || '').trim();
  if (!value) return null;
  if (value.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(value)));
  return Keypair.fromSecretKey(bs58.decode(value));
}

export function initLiveExecution() {
  if (!SOLANA_PRIVATE_KEY) return;
  try {
    liveWallet = parseKeypair(SOLANA_PRIVATE_KEY);
    solanaConnection = getRotatedConnection();
    console.log(`[live] wallet loaded ${liveWallet.publicKey.toBase58()}`);
  } catch (err) {
    liveWallet = null;
    solanaConnection = null;
    console.log(`[live] wallet load failed: ${err.message}`);
  }
}

export function liveWalletPubkey() {
  return liveWallet?.publicKey?.toBase58() || null;
}

export async function fetchLiveTokenBalance(mint) {
  if (!liveWallet || !solanaConnection) return null;
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const conn = attempt === 1 ? solanaConnection : getRotatedConnection();
      const accounts = await conn.getParsedTokenAccountsByOwner(
        liveWallet.publicKey,
        { mint: new PublicKey(mint) },
        'confirmed',
      );
      return accounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.amount || null;
    } catch (err) {
      const is429 = err.message?.includes('429') || err.message?.includes('rate limit') || err.message?.includes('max usage');
      if (is429 && attempt < maxAttempts) {
        console.log(`[live] token balance RPC 429 — rotating key (attempt ${attempt})`);
        continue;
      }
      console.log(`[live] token balance ${mint.slice(0, 8)}... ${err.message}`);
      return null;
    }
  }
  return null;
}

export function requireLiveExecution() {
  if (!liveWallet || !solanaConnection) throw new Error('SOLANA_PRIVATE_KEY is required for live execution.');
  if (!JUPITER_API_KEY) throw new Error('JUPITER_API_KEY is required for live execution.');
}

export async function liveWalletBalanceLamports() {
  requireLiveExecution();
  // Cache balance for 60s to avoid hammering APIs
  if (cachedBalance != null && now() - cachedBalance.at < 60_000) {
    return cachedBalance.lamports;
  }
  const pubkey = liveWallet.publicKey.toBase58();

  // Try GMGN first (already have API key + queued)
  try {
    const { fetchGmgnWalletBalance } = await import('./enrichment/gmgn.js');
    const gmgnBal = await fetchGmgnWalletBalance(pubkey);
    if (gmgnBal != null) {
      cachedBalance = { lamports: gmgnBal, at: now() };
      return gmgnBal;
    }
  } catch {}

  // Fallback: RPC with key rotation on 429
  for (let attempt = 1; attempt <= 6; attempt++) {
    const rpcUrl = nextRpcUrl();
    if (rpcUrl === 'https://api.mainnet-beta.solana.com' && attempt > 3) break; // don't spam public RPC
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBalance',
          params: [pubkey],
        }),
      });
      const data = await res.json();
      if (data?.result?.value != null) {
        const lamports = Number(data.result.value);
        cachedBalance = { lamports, at: now() };
        return lamports;
      }
      // 429 = rate limited, try next key
      if (res.status === 429 || data?.error?.code === -32429 || data?.error?.code === 429) {
        console.log(`[live] RPC 429 — rotating to next key (attempt ${attempt})`);
        continue;
      }
      break;
    } catch {
      continue;
    }
  }
  // Final fallback
  if (cachedBalance != null) {
    console.log(`[live] all balance sources failed, using cached balance from ${((now() - cachedBalance.at) / 1000).toFixed(0)}s ago`);
    return cachedBalance.lamports;
  }
  throw new Error('All balance sources failed (GMGN + RPC) — wallet may not exist');
}

async function jupiterOrder({ inputMint, outputMint, amount }) {
  requireLiveExecution();
  const url = new URL(`${JUPITER_SWAP_BASE_URL.replace(/\/$/, '')}/order`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('taker', liveWallet.publicKey.toBase58());
  const res = await axios.get(url.toString(), {
    timeout: 20_000,
    headers: { ...JSON_HEADERS, 'x-api-key': JUPITER_API_KEY },
  });
  const order = res.data;
  if (order.errorCode || order.error) {
    throw new Error(`Jupiter order failed: ${order.errorMessage || order.error || order.errorCode}`);
  }
  return order;
}

function orderTransactionBase64(order) {
  return order?.transaction || order?.swapTransaction || null;
}

function signTransactionBase64(transactionBase64) {
  const tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
  tx.sign([liveWallet]);
  return Buffer.from(tx.serialize()).toString('base64');
}

async function jupiterExecute(order, signedTransaction) {
  requireLiveExecution();
  const body = {
    signedTransaction,
    requestId: order.requestId,
  };
  const res = await axios.post(`${JUPITER_SWAP_BASE_URL.replace(/\/$/, '')}/execute`, body, {
    timeout: 30_000,
    headers: { ...JSON_HEADERS, 'content-type': 'application/json', 'x-api-key': JUPITER_API_KEY },
  });
  return res.data;
}

export async function executeJupiterSwap({ inputMint, outputMint, amount }) {
  const order = await jupiterOrder({ inputMint, outputMint, amount });
  const transaction = orderTransactionBase64(order);
  if (!transaction) throw new Error('Jupiter order did not include a transaction.');
  const signedTransaction = signTransactionBase64(transaction);
  const executed = await jupiterExecute(order, signedTransaction);
  if (executed?.status && executed.status !== 'Success') {
    throw new Error(`Jupiter execute failed: ${executed.error || executed.code || executed.status}`);
  }
  const signature = executed?.signature || executed?.txid || executed?.transactionId || null;
  if (!signature) {
    throw new Error(`Jupiter execute returned no signature (status: ${executed?.status || 'unknown'})`);
  }
  return {
    order,
    executed,
    signature,
    inputAmount: String(amount),
    outputAmount: String(executed?.outputAmountResult || executed?.totalOutputAmount || order?.outAmount || ''),
  };
}
