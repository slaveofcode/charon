/**
 * On-chain wallet profiling functions
 *
 * Provides wallet balance, age, token diversity, and a combined risk profile.
 * Results are cached via the shared RPC cache (5 min default TTL).
 */
import { Connection, PublicKey } from '@solana/web3.js'
import { SOLANA_RPC_URL } from '../config.js'
import { walletCache } from '../enrichment/rpcCache.js'

/** @type {Connection} */
let connection = new Connection(SOLANA_RPC_URL, 'confirmed')

/**
 * Override the connection for testing purposes.
 * @param {Connection|null} mock
 */
export function setTestConnection(mock) {
  if (mock) connection = mock
}

/**
 * Return the SOL balance for an address as a number (lamports / 1e9).
 * Returns 0 on any error.
 * @param {string} address
 * @returns {Promise<number>}
 */
export async function walletSolBalance(address) {
  const cacheKey = `balance:${address}`
  const cached = walletCache.get(cacheKey)
  if (cached !== null) return cached

  try {
    const lamports = await connection.getBalance(new PublicKey(address))
    const sol = lamports / 1e9
    walletCache.set(cacheKey, sol)
    return sol
  } catch {
    return 0
  }
}

/**
 * Return the age of a wallet in milliseconds (time since first signature).
 * Returns null on error or if no signatures exist.
 * @param {string} address
 * @returns {Promise<number|null>}
 */
export async function walletAgeMs(address) {
  const cacheKey = `age:${address}`
  const cached = walletCache.get(cacheKey)
  if (cached !== null) return cached

  try {
    const sigs = await connection.getSignaturesForAddress(
      new PublicKey(address),
      { limit: 1 },
      'confirmed',
    )
    if (!sigs || sigs.length === 0) {
      walletCache.set(cacheKey, null)
      return null
    }

    // Signatures are returned newest-first, so the last element is the oldest
    const oldest = sigs[sigs.length - 1]
    if (oldest.blockTime == null) {
      walletCache.set(cacheKey, null)
      return null
    }

    const age = Date.now() - (oldest.blockTime * 1000)
    walletCache.set(cacheKey, age)
    return age
  } catch {
    return null
  }
}

/**
 * Return the count of distinct token mints held by this wallet with balance > 0.
 * Returns 0 on error.
 * @param {string} address
 * @returns {Promise<number>}
 */
export async function walletDistinctTokensHeld(address) {
  const cacheKey = `tokens:${address}`
  const cached = walletCache.get(cacheKey)
  if (cached !== null) return cached

  try {
    const { value } = await connection.getParsedTokenAccountsByOwner(
      new PublicKey(address),
      undefined,
      'confirmed',
    )
    const count = value.filter(
      acc => Number(acc.account.data.parsed.info.tokenAmount.amount) > 0,
    ).length
    walletCache.set(cacheKey, count)
    return count
  } catch {
    return 0
  }
}

/**
 * Build a combined wallet risk profile.
 *
 * Tags are derived automatically:
 *  - 'new'    : ageHours < 24
 *  - 'dust'   : solBalance < 0.01
 *  - 'active' : ageHours >= 24
 *  - 'multi'  : distinctTokens >= 5
 *
 * @param {string} address
 * @returns {Promise<{
 *   address: string,
 *   solBalance: number,
 *   ageMs: number|null,
 *   ageHours: number|null,
 *   distinctTokens: number,
 *   isNew: boolean,
 *   isDust: boolean,
 *   tags: string[],
 * }>}
 */
export async function walletRiskProfile(address) {
  const [solBalance, ageMs, distinctTokens] = await Promise.all([
    walletSolBalance(address),
    walletAgeMs(address),
    walletDistinctTokensHeld(address),
  ])

  const ageHours = ageMs !== null ? Math.round(ageMs / 3_600_000) : null
  const isNew = ageMs !== null && ageHours < 24
  const isDust = solBalance < 0.01

  const tags = []
  if (isNew) tags.push('new')
  if (isDust) tags.push('dust')
  if (ageMs !== null && !isNew) tags.push('active')
  if (distinctTokens >= 5) tags.push('multi')

  return {
    address,
    solBalance,
    ageMs,
    ageHours,
    distinctTokens,
    isNew,
    isDust,
    tags,
  }
}
