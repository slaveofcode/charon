import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'

// Import the module under test (connection is lazy, we'll mock via setTestConnection)
import {
  walletSolBalance,
  walletAgeMs,
  walletDistinctTokensHeld,
  walletRiskProfile,
  setTestConnection,
} from '../src/analysis/walletProfile.js'
import { walletCache } from '../src/enrichment/rpcCache.js'

/**
 * Build a mock Connection that returns known values for each method.
 */
function makeMockConnection(overrides = {}) {
  const defaults = {
    getBalance: async () => 10_000_000_000,       // 10 SOL
    getSignaturesForAddress: async () => [
      { blockTime: Math.floor(Date.now() / 1000) - 72 * 3600 },  // 72 hours ago (oldest/newest-first: only one)
    ],
    getParsedTokenAccountsByOwner: async () => ({
      value: [
        makeParsedTokenAccount('mint1', '500'),
        makeParsedTokenAccount('mint2', '0'),
        makeParsedTokenAccount('mint3', '200'),
      ],
    }),
  }
  const merged = { ...defaults, ...overrides }
  return {
    getBalance: merged.getBalance,
    getSignaturesForAddress: merged.getSignaturesForAddress,
    getParsedTokenAccountsByOwner: merged.getParsedTokenAccountsByOwner,
  }
}

function makeParsedTokenAccount(mint, amount) {
  return {
    pubkey: mint,
    account: {
      data: {
        parsed: {
          info: {
            mint,
            tokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6 },
          },
        },
      },
    },
  }
}

describe('walletProfile module', () => {
  const testAddress = 'So11111111111111111111111111111111111111112'

  beforeEach(() => {
    walletCache.clear()
  })

  it('exports all expected functions', () => {
    assert.strictEqual(typeof walletSolBalance, 'function')
    assert.strictEqual(typeof walletAgeMs, 'function')
    assert.strictEqual(typeof walletDistinctTokensHeld, 'function')
    assert.strictEqual(typeof walletRiskProfile, 'function')
    assert.strictEqual(typeof setTestConnection, 'function')
  })

  it('walletSolBalance returns a number', async () => {
    setTestConnection(makeMockConnection())
    const balance = await walletSolBalance(testAddress)
    assert.strictEqual(typeof balance, 'number')
    assert.strictEqual(balance, 10)
  })

  it('walletSolBalance returns 0 on error', async () => {
    setTestConnection(makeMockConnection({
      getBalance: async () => { throw new Error('RPC error') },
    }))
    const balance = await walletSolBalance(testAddress)
    assert.strictEqual(balance, 0)
  })

  it('walletAgeMs returns a number', async () => {
    const ageSeconds = 72 * 3600
    const mockBlockTime = Math.floor(Date.now() / 1000) - ageSeconds
    setTestConnection(makeMockConnection({
      getSignaturesForAddress: async () => [
        { blockTime: mockBlockTime },
      ],
    }))
    const age = await walletAgeMs(testAddress)
    assert.strictEqual(typeof age, 'number')
    // Allow a small tolerance for timing
    assert.ok(Math.abs(age - ageSeconds * 1000) < 2000)
  })

  it('walletAgeMs returns null for wallet with no signatures', async () => {
    setTestConnection(makeMockConnection({
      getSignaturesForAddress: async () => [],
    }))
    const age = await walletAgeMs(testAddress)
    assert.strictEqual(age, null)
  })

  it('walletAgeMs returns null on error', async () => {
    setTestConnection(makeMockConnection({
      getSignaturesForAddress: async () => { throw new Error('RPC error') },
    }))
    const age = await walletAgeMs(testAddress)
    assert.strictEqual(age, null)
  })

  it('walletDistinctTokensHeld counts only non-zero balances', async () => {
    setTestConnection(makeMockConnection())
    const count = await walletDistinctTokensHeld(testAddress)
    // 3 accounts, 2 with balance > 0
    assert.strictEqual(count, 2)
  })

  it('walletDistinctTokensHeld returns 0 on error', async () => {
    setTestConnection(makeMockConnection({
      getParsedTokenAccountsByOwner: async () => { throw new Error('RPC error') },
    }))
    const count = await walletDistinctTokensHeld(testAddress)
    assert.strictEqual(count, 0)
  })

  it('walletRiskProfile returns the correct shape', async () => {
    setTestConnection(makeMockConnection())
    const profile = await walletRiskProfile(testAddress)

    assert.ok(profile)
    assert.strictEqual(profile.address, testAddress)
    assert.strictEqual(typeof profile.solBalance, 'number')
    assert.strictEqual(typeof profile.ageMs, 'number')
    assert.strictEqual(typeof profile.ageHours, 'number')
    assert.strictEqual(typeof profile.distinctTokens, 'number')
    assert.strictEqual(typeof profile.isNew, 'boolean')
    assert.strictEqual(typeof profile.isDust, 'boolean')
    assert.ok(Array.isArray(profile.tags))
  })

  it('walletRiskProfile tags a dust wallet', async () => {
    setTestConnection(makeMockConnection({
      getBalance: async () => 500_000, // 0.0005 SOL — under 0.01
    }))
    const profile = await walletRiskProfile(testAddress)
    assert.strictEqual(profile.isDust, true)
    assert.ok(profile.tags.includes('dust'))
    assert.strictEqual(profile.solBalance, 0.0005)
  })

  it('walletRiskProfile tags a new wallet', async () => {
    const mockBlockTime = Math.floor(Date.now() / 1000) - 1 * 3600 // 1 hour ago
    setTestConnection(makeMockConnection({
      getSignaturesForAddress: async () => [
        { blockTime: mockBlockTime },
      ],
    }))
    const profile = await walletRiskProfile(testAddress)
    assert.strictEqual(profile.isNew, true)
    assert.ok(profile.tags.includes('new'))
    assert.ok(profile.ageHours < 24)
  })

  it('walletRiskProfile tags an active wallet (older than 24h)', async () => {
    const mockBlockTime = Math.floor(Date.now() / 1000) - 72 * 3600 // 72 hours ago
    setTestConnection(makeMockConnection({
      getSignaturesForAddress: async () => [
        { blockTime: mockBlockTime },
      ],
    }))
    const profile = await walletRiskProfile(testAddress)
    assert.strictEqual(profile.isNew, false)
    assert.ok(profile.tags.includes('active'))
    assert.ok(!profile.tags.includes('new'))
  })

  it('walletRiskProfile tags multi-token wallets', async () => {
    setTestConnection(makeMockConnection({
      getParsedTokenAccountsByOwner: async () => ({
        value: [
          makeParsedTokenAccount('mint1', '100'),
          makeParsedTokenAccount('mint2', '200'),
          makeParsedTokenAccount('mint3', '300'),
          makeParsedTokenAccount('mint4', '400'),
          makeParsedTokenAccount('mint5', '500'),
        ],
      }),
    }))
    const profile = await walletRiskProfile(testAddress)
    assert.strictEqual(profile.distinctTokens, 5)
    assert.ok(profile.tags.includes('multi'))
  })

  it('walletRiskProfile handles RPC errors gracefully', async () => {
    setTestConnection(makeMockConnection({
      getBalance: async () => { throw new Error('RPC fail') },
      getSignaturesForAddress: async () => { throw new Error('RPC fail') },
      getParsedTokenAccountsByOwner: async () => { throw new Error('RPC fail') },
    }))
    const profile = await walletRiskProfile(testAddress)
    assert.strictEqual(profile.solBalance, 0)
    assert.strictEqual(profile.ageMs, null)
    assert.strictEqual(profile.ageHours, null)
    assert.strictEqual(profile.distinctTokens, 0)
    assert.strictEqual(profile.isNew, false)
    assert.strictEqual(profile.isDust, true)
    assert.deepStrictEqual(profile.tags, ['dust'])
  })
})
