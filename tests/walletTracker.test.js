import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import {
  recordWalletObservation,
  updateWalletObservationOnClose,
  getProvenWallets,
  getWalletByAddress,
  getObservationsByWallet,
  flagWalletAsBot,
  createWalletTables,
} from '../src/analysis/walletTracker.js';

/** Create fresh in-memory DB for testing */
function makeTestDb() {
  const d = new Database(':memory:');
  createWalletTables(d);
  return d;
}

describe('walletTracker', () => {
  let testDb;

  before(() => { testDb = makeTestDb(); });
  after(() => { testDb?.close(); });

  describe('recordWalletObservation', () => {
    it('should insert a new observation and tracking entry', () => {
      const id = recordWalletObservation('wallet1', 'mint1', 5.5, 0.001, 10000, ['early'], testDb);
      assert.ok(id, 'should return observation id');

      const tracking = getWalletByAddress('wallet1', testDb);
      assert.ok(tracking);
      assert.strictEqual(tracking.total_calls, 1);
      assert.strictEqual(tracking.is_bot_flag, 0);
    });

    it('should increment total_calls for existing wallet', () => {
      recordWalletObservation('wallet1', 'mint2', 3.0, 0.002, 20000, [], testDb);
      const tracking = getWalletByAddress('wallet1', testDb);
      assert.strictEqual(tracking.total_calls, 2);
    });

    it('should not duplicate observation for same wallet+mint', () => {
      const id1 = recordWalletObservation('wallet1', 'mint1', 5.5, 0.001, 10000, [], testDb);
      const id2 = recordWalletObservation('wallet1', 'mint1', 5.5, 0.001, 10000, [], testDb);
      assert.strictEqual(id1, id2, 'should return same id for duplicate');
    });

    it('should handle null optional fields', () => {
      const id = recordWalletObservation('wallet2', 'mint3', null, null, null, [], testDb);
      assert.ok(id);
      const obs = testDb.prepare('SELECT * FROM wallet_observations WHERE id = ?').get(id);
      assert.strictEqual(obs.entry_price, null);
      assert.strictEqual(obs.entry_mcap, null);
    });
  });

  describe('updateWalletObservationOnClose', () => {
    it('should update observation with exit data', () => {
      const id = recordWalletObservation('wallet3', 'mint-profit', 10.0, 0.001, 10000, [], testDb);

      // Set position_id
      testDb.prepare('UPDATE wallet_observations SET position_id = ? WHERE id = ?').run(999, id);

      const result = updateWalletObservationOnClose(999, 0.002, 20000, 50, testDb);
      assert.strictEqual(result, id);

      const obs = testDb.prepare('SELECT * FROM wallet_observations WHERE id = ?').get(id);
      assert.strictEqual(obs.exit_price, 0.002);
      assert.strictEqual(obs.exit_mcap, 20000);
      assert.strictEqual(obs.pnl_percent, 50);
      assert.ok(obs.held_duration_ms >= 0, 'held_duration should be >= 0');
    });

    it('should increment profitable_calls on positive PnL', () => {
      const id = recordWalletObservation('wallet4', 'mint-profit2', 5.0, 0.001, 10000, [], testDb);
      testDb.prepare('UPDATE wallet_observations SET position_id = ? WHERE id = ?').run(1000, id);

      updateWalletObservationOnClose(1000, 0.002, 20000, 25, testDb);
      const tracking = getWalletByAddress('wallet4', testDb);
      assert.strictEqual(tracking.profitable_calls, 1);
    });

    it('should NOT increment profitable_calls on negative PnL', () => {
      const id = recordWalletObservation('wallet5', 'mint-loss', 5.0, 0.001, 10000, [], testDb);
      testDb.prepare('UPDATE wallet_observations SET position_id = ? WHERE id = ?').run(1001, id);

      updateWalletObservationOnClose(1001, 0.0005, 5000, -40, testDb);
      const tracking = getWalletByAddress('wallet5', testDb);
      assert.strictEqual(tracking.profitable_calls, 0);
    });

    it('should auto-tag smart on PnL > 20%', () => {
      const id = recordWalletObservation('wallet6', 'mint-smart', 5.0, 0.001, 10000, [], testDb);
      testDb.prepare('UPDATE wallet_observations SET position_id = ? WHERE id = ?').run(1002, id);

      updateWalletObservationOnClose(1002, 0.003, 30000, 55, testDb);
      const tracking = getWalletByAddress('wallet6', testDb);
      const tags = JSON.parse(tracking.tags);
      assert.ok(tags.includes('smart'), 'should tag as smart');
    });

    it('should auto-tag dumper on PnL < -30%', () => {
      const id = recordWalletObservation('wallet7', 'mint-dump', 5.0, 0.001, 10000, [], testDb);
      testDb.prepare('UPDATE wallet_observations SET position_id = ? WHERE id = ?').run(1003, id);

      updateWalletObservationOnClose(1003, 0.0001, 1000, -70, testDb);
      const tracking = getWalletByAddress('wallet7', testDb);
      const tags = JSON.parse(tracking.tags);
      assert.ok(tags.includes('dumper'), 'should tag as dumper');
    });

    it('should return null for unknown position_id', () => {
      const result = updateWalletObservationOnClose(99999, 0.001, 10000, 10, testDb);
      assert.strictEqual(result, null);
    });
  });

  describe('getProvenWallets', () => {
    it('should return wallets meeting minCalls and minWinRate', () => {
      // wallet4 has 1 call with 25% profit → profitable, not meeting minCalls=3
      // Create a wallet with 3 profitable calls
      for (let i = 0; i < 3; i++) {
        const id = recordWalletObservation('proven1', `mint-p${i}`, 5.0, 0.001, 10000, [], testDb);
        testDb.prepare('UPDATE wallet_observations SET position_id = ? WHERE id = ?').run(2000 + i, id);
        updateWalletObservationOnClose(2000 + i, 0.002, 20000, 30, testDb);
      }

      const proven = getProvenWallets(3, 0.6, testDb);
      const found = proven.find(w => w.address === 'proven1');
      assert.ok(found, 'should find proven wallet');
      assert.ok(found.win_rate >= 0.6, 'win rate should be >= 0.6');
    });

    it('should exclude wallets flagged as bot', () => {
      flagWalletAsBot('proven1', testDb);
      const proven = getProvenWallets(3, 0.6, testDb);
      const found = proven.find(w => w.address === 'proven1');
      assert.ok(!found, 'should exclude bot-flagged wallets');
    });

    it('should return empty for no qualifying wallets', () => {
      const result = getProvenWallets(999, 0.99, testDb);
      assert.ok(Array.isArray(result));
      assert.strictEqual(result.length, 0);
    });
  });

  describe('getWalletByAddress', () => {
    it('should return null for unknown address', () => {
      assert.strictEqual(getWalletByAddress('nonexistent', testDb), null);
    });

    it('should return tracking data for known address', () => {
      const t = getWalletByAddress('wallet1', testDb);
      assert.ok(t);
      assert.strictEqual(t.address, 'wallet1');
    });
  });

  describe('getObservationsByWallet', () => {
    it('should return observations sorted by most recent', () => {
      const obs = getObservationsByWallet('wallet1', 10, testDb);
      assert.ok(obs.length >= 2, 'should have multiple observations');
      // Most recent first
      assert.ok(obs[0].observed_at_ms >= obs[obs.length - 1].observed_at_ms);
    });

    it('should respect limit', () => {
      const obs = getObservationsByWallet('wallet1', 1, testDb);
      assert.strictEqual(obs.length, 1);
    });
  });

  describe('flagWalletAsBot', () => {
    it('should set is_bot_flag to 1', () => {
      recordWalletObservation('botwallet', 'mint-bot', 10.0, 0.001, 10000, [], testDb);
      flagWalletAsBot('botwallet', testDb);
      const t = getWalletByAddress('botwallet', testDb);
      assert.strictEqual(t.is_bot_flag, 1);
    });
  });
});
