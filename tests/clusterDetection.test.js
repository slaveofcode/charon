/**
 * Tests for clusterDetection.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  findFundingSources,
  detectClusters,
  setTestConnection,
  setTestGetTransaction,
  setTestGetSignaturesForAddress,
} from '../src/analysis/clusterDetection.js';
import { walletCache } from '../src/enrichment/rpcCache.js';

// --- Sample holder data ---
const HOLDER_A = { address: '11111111111111111111111111111111', rank: 1, amount: 1000, percent: 10, tags: [] };
const HOLDER_B = { address: '22222222222222222222222222222222222222222222', rank: 2, amount: 800, percent: 8, tags: [] };
const HOLDER_C = { address: '33333333333333333333333333333333333333333333', rank: 3, amount: 600, percent: 6, tags: [] };
const HOLDER_D = { address: '44444444444444444444444444444444444444444444', rank: 4, amount: 400, percent: 4, tags: [] };
const HOLDER_E = { address: '55555555555555555555555555555555555555555555', rank: 5, amount: 200, percent: 2, tags: [] };

const FUNDING_SOURCE = 'FUNDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

function makeMockConnection() {
  return {};
}

/**
 * Build a mock getTransaction response.
 *
 * @param {string} targetAddress - the wallet that received SOL
 * @param {string} senderAddress - the wallet that sent SOL
 * @param {number} sendAmount - amount of SOL sent (in lamports)
 * @returns {object} mock transaction object
 */
function makeMockTx(targetAddress, senderAddress, sendAmount = 100_000_000) {
  const targetIsFirst = targetAddress < senderAddress;
  const keys = targetIsFirst
    ? [targetAddress, senderAddress]
    : [senderAddress, targetAddress];

  const targetIdx = keys.indexOf(targetAddress);
  const senderIdx = keys.indexOf(senderAddress);

  const preBalances = [0, 0];
  const postBalances = [0, 0];

  preBalances[senderIdx] = sendAmount + 5000; // had balance
  postBalances[senderIdx] = 0;                // spent it all (approx)
  preBalances[targetIdx] = 0;
  postBalances[targetIdx] = sendAmount;       // received

  return {
    transaction: {
      message: {
        accountKeys: keys,
      },
    },
    meta: {
      preBalances,
      postBalances,
    },
  };
}

/**
 * Reset all test overrides and cache.
 */
function resetMocks() {
  setTestConnection(null);
  setTestGetTransaction(null);
  setTestGetSignaturesForAddress(null);
  walletCache.clear();
}

describe('clusterDetection', () => {
  describe('findFundingSources', () => {
    it('returns empty map for empty holders', async () => {
      resetMocks();
      const result = await findFundingSources([]);
      assert.ok(result instanceof Map);
      assert.strictEqual(result.size, 0);
    });

    it('returns empty map for null/undefined holders', async () => {
      resetMocks();
      const result1 = await findFundingSources(null);
      assert.ok(result1 instanceof Map);
      assert.strictEqual(result1.size, 0);

      const result2 = await findFundingSources(undefined);
      assert.ok(result2 instanceof Map);
      assert.strictEqual(result2.size, 0);
    });

    it('maps addresses to their funding source', async () => {
      resetMocks();
      setTestConnection(makeMockConnection());

      const sigsForAddress = {};
      const txs = {};

      sigsForAddress[HOLDER_A.address] = [{ signature: 'sig_a1' }];
      sigsForAddress[HOLDER_B.address] = [{ signature: 'sig_b1' }];

      txs.sig_a1 = makeMockTx(HOLDER_A.address, FUNDING_SOURCE, 500_000_000);
      txs.sig_b1 = makeMockTx(HOLDER_B.address, FUNDING_SOURCE, 300_000_000);

      setTestGetSignaturesForAddress((addr) => sigsForAddress[addr] || []);
      setTestGetTransaction((sig) => txs[sig] || null);

      const result = await findFundingSources([HOLDER_A, HOLDER_B]);

      assert.strictEqual(result.size, 1);
      assert.ok(result.has(FUNDING_SOURCE));
      assert.deepStrictEqual(result.get(FUNDING_SOURCE), [HOLDER_A.address, HOLDER_B.address]);
    });

    it('groups wallets by different funding sources', async () => {
      resetMocks();
      setTestConnection(makeMockConnection());

      const sourceA = 'SOURCE11111111111111111111111111111111111';
      const sourceB = 'SOURCE22222222222222222222222222222222222';

      const sigsForAddress = {};
      const txs = {};

      sigsForAddress[HOLDER_A.address] = [{ signature: 'sig_a1' }];
      sigsForAddress[HOLDER_B.address] = [{ signature: 'sig_b1' }];

      txs.sig_a1 = makeMockTx(HOLDER_A.address, sourceA, 500_000_000);
      txs.sig_b1 = makeMockTx(HOLDER_B.address, sourceB, 300_000_000);

      setTestGetSignaturesForAddress((addr) => sigsForAddress[addr] || []);
      setTestGetTransaction((sig) => txs[sig] || null);

      const result = await findFundingSources([HOLDER_A, HOLDER_B]);

      assert.strictEqual(result.size, 2);
      assert.ok(result.has(sourceA));
      assert.ok(result.has(sourceB));
      assert.strictEqual(result.get(sourceA).length, 1);
      assert.strictEqual(result.get(sourceB).length, 1);
    });

    it('handles errors gracefully (invalid address, no crash)', async () => {
      resetMocks();
      setTestConnection(makeMockConnection());

      setTestGetSignaturesForAddress(() => { throw new Error('RPC error'); });
      setTestGetTransaction(() => { throw new Error('RPC error'); });

      const result = await findFundingSources([HOLDER_A]);
      // Should not crash — returns empty map or map with empty source groups
      assert.ok(result instanceof Map);
    });

    it('skips wallets with no signatures', async () => {
      resetMocks();
      setTestConnection(makeMockConnection());
      setTestGetSignaturesForAddress(() => []);
      setTestGetTransaction(() => null);

      const result = await findFundingSources([HOLDER_A]);
      assert.strictEqual(result.size, 0);
    });

    it('uses cached results on subsequent calls', async () => {
      resetMocks();
      setTestConnection(makeMockConnection());

      let callCount = 0;
      setTestGetSignaturesForAddress((addr) => {
        callCount++;
        return [{ signature: 'sig_' + addr }];
      });
      setTestGetTransaction((sig) => makeMockTx(HOLDER_A.address, FUNDING_SOURCE, 100_000_000));

      // First call — should trace
      await findFundingSources([HOLDER_A]);
      assert.strictEqual(callCount, 1, 'should have called getSignaturesForAddress once');

      // Second call — should use cache
      await findFundingSources([HOLDER_A]);
      assert.strictEqual(callCount, 1, 'should NOT call getSignaturesForAddress again (cached)');
    });
  });

  describe('detectClusters', () => {
    it('returns no clusters for empty holders', async () => {
      resetMocks();
      const result = await detectClusters([]);

      assert.strictEqual(result.clusterFound, false);
      assert.strictEqual(result.totalChecked, 0);
      assert.strictEqual(result.maxClusterSize, 0);
      assert.strictEqual(result.clusterCount, 0);
      assert.strictEqual(result.clusters.length, 0);
      assert.strictEqual(result.score, 0);
      assert.strictEqual(result.level, 'none');
    });

    it('detects a bot army when all wallets share same source (5 wallets)', async () => {
      resetMocks();
      setTestConnection(makeMockConnection());

      const sigs = {};
      const txs = {};

      const holders = [HOLDER_A, HOLDER_B, HOLDER_C, HOLDER_D, HOLDER_E];
      for (const h of holders) {
        sigs[h.address] = [{ signature: 'sig_' + h.address }];
        txs['sig_' + h.address] = makeMockTx(h.address, FUNDING_SOURCE, 100_000_000);
      }

      setTestGetSignaturesForAddress((addr) => sigs[addr] || []);
      setTestGetTransaction((sig) => txs[sig] || null);

      const result = await detectClusters(holders);

      assert.strictEqual(result.clusterFound, true);
      assert.strictEqual(result.totalChecked, 5);
      assert.strictEqual(result.maxClusterSize, 5);
      assert.strictEqual(result.clusterCount, 1);
      assert.strictEqual(result.clusters.length, 1);
      assert.strictEqual(result.clusters[0].source, FUNDING_SOURCE);
      assert.strictEqual(result.clusters[0].count, 5);
      assert.strictEqual(result.score, 100);
      assert.strictEqual(result.level, 'bot_army');
    });

    it('detects a cluster (3 wallets from same source)', async () => {
      resetMocks();
      setTestConnection(makeMockConnection());

      const sourceA = 'SOURCEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const sourceB = 'SOURCEBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

      const sigs = {};
      const txs = {};

      // 3 wallets from sourceA, 2 from sourceB
      const groupA = [HOLDER_A, HOLDER_B, HOLDER_C];
      const groupB = [HOLDER_D, HOLDER_E];

      for (const h of groupA) {
        sigs[h.address] = [{ signature: 'sig_a_' + h.address }];
        txs['sig_a_' + h.address] = makeMockTx(h.address, sourceA, 100_000_000);
      }
      for (const h of groupB) {
        sigs[h.address] = [{ signature: 'sig_b_' + h.address }];
        txs['sig_b_' + h.address] = makeMockTx(h.address, sourceB, 100_000_000);
      }

      setTestGetSignaturesForAddress((addr) => sigs[addr] || []);
      setTestGetTransaction((sig) => txs[sig] || null);

      const result = await detectClusters([HOLDER_A, HOLDER_B, HOLDER_C, HOLDER_D, HOLDER_E]);

      assert.strictEqual(result.clusterFound, true);
      assert.strictEqual(result.totalChecked, 5);
      assert.strictEqual(result.maxClusterSize, 3);
      assert.strictEqual(result.clusterCount, 2);

      // score: (3 / 5) * 100 = 60
      assert.strictEqual(result.score, 60);
      assert.strictEqual(result.level, 'cluster');
    });

    it('returns level=none for maxClusterSize < 3', async () => {
      resetMocks();
      setTestConnection(makeMockConnection());

      const sourceA = 'SOURCEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const sourceB = 'SOURCEBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

      const sigs = {};
      const txs = {};

      sigs[HOLDER_A.address] = [{ signature: 'sig_a' }];
      sigs[HOLDER_B.address] = [{ signature: 'sig_b' }];
      txs.sig_a = makeMockTx(HOLDER_A.address, sourceA, 100_000_000);
      txs.sig_b = makeMockTx(HOLDER_B.address, sourceB, 100_000_000);

      setTestGetSignaturesForAddress((addr) => sigs[addr] || []);
      setTestGetTransaction((sig) => txs[sig] || null);

      const result = await detectClusters([HOLDER_A, HOLDER_B]);

      // Each source has 1 wallet → no cluster (need >= 2)
      assert.strictEqual(result.clusterFound, false);
      assert.strictEqual(result.maxClusterSize, 0);
      assert.strictEqual(result.clusterCount, 0);
      assert.strictEqual(result.score, 0);
      assert.strictEqual(result.level, 'none');
    });

    it('returns correct score = (maxClusterSize / totalChecked) * 100', async () => {
      resetMocks();
      setTestConnection(makeMockConnection());

      const sourceA = 'SOURCEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

      const sigs = {};
      const txs = {};

      // 3 wallets from sourceA, 2 wallets unfunded (no signatures)
      const funded = [HOLDER_A, HOLDER_B, HOLDER_C];
      const unfunded = [HOLDER_D, HOLDER_E];

      for (const h of funded) {
        sigs[h.address] = [{ signature: 'sig_' + h.address }];
        txs['sig_' + h.address] = makeMockTx(h.address, sourceA, 100_000_000);
      }
      for (const h of unfunded) {
        sigs[h.address] = [];
      }

      setTestGetSignaturesForAddress((addr) => sigs[addr] || []);
      setTestGetTransaction((sig) => txs[sig] || null);

      const result = await detectClusters([HOLDER_A, HOLDER_B, HOLDER_C, HOLDER_D, HOLDER_E]);

      // 3 funded wallets, all from same source → maxClusterSize=3, totalChecked=3
      assert.strictEqual(result.totalChecked, 3);
      assert.strictEqual(result.maxClusterSize, 3);
      assert.strictEqual(result.score, 100);
    });
  });
});
