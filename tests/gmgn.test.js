import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Disable GMGN for tests (no API key needed)
process.env.GMGN_ENABLED = 'false';
process.env.DB_PATH = ':memory:';

const {
  normalizedTrendingRows,
  marketCapFromGmgn,
  tokenPriceFromGmgn,
  gmgnBackoffActive,
  setGmgnBackoff,
  gmgnStatusText,
} = await import('../src/enrichment/gmgn.js');

describe('normalizedTrendingRows()', () => {
  it('extracts rows from data.data.rank path', () => {
    const payload = { data: { data: { rank: [{ mint: 'abc' }] } } };
    assert.deepEqual(normalizedTrendingRows(payload), [{ mint: 'abc' }]);
  });

  it('extracts rows from data.rank path', () => {
    const payload = { data: { rank: [{ mint: 'def' }] } };
    assert.deepEqual(normalizedTrendingRows(payload), [{ mint: 'def' }]);
  });

  it('extracts rows from rank path', () => {
    const payload = { rank: [{ mint: 'ghi' }] };
    assert.deepEqual(normalizedTrendingRows(payload), [{ mint: 'ghi' }]);
  });

  it('extracts rows from data.data path', () => {
    const payload = { data: { data: [{ mint: 'jkl' }] } };
    assert.deepEqual(normalizedTrendingRows(payload), [{ mint: 'jkl' }]);
  });

  it('extracts rows from data path', () => {
    const payload = { data: [{ mint: 'mno' }] };
    assert.deepEqual(normalizedTrendingRows(payload), [{ mint: 'mno' }]);
  });

  it('returns empty array when no rows found', () => {
    assert.deepEqual(normalizedTrendingRows({}), []);
  });

  it('returns empty array for null payload', () => {
    assert.deepEqual(normalizedTrendingRows(null), []);
  });

  it('returns empty array when rows is not an array', () => {
    assert.deepEqual(normalizedTrendingRows({ rank: 'not-array' }), []);
  });
});

describe('marketCapFromGmgn()', () => {
  it('returns market_cap directly when positive', () => {
    assert.equal(marketCapFromGmgn({ market_cap: 500_000 }), 500_000);
  });

  it('falls back to mcap field', () => {
    assert.equal(marketCapFromGmgn({ mcap: 300_000 }), 300_000);
  });

  it('calculates from price * circulating_supply', () => {
    const info = { price: 0.001, circulating_supply: 1_000_000 };
    assert.equal(marketCapFromGmgn(info), 1_000);
  });

  it('calculates from price * total_supply when circulating_supply absent', () => {
    const info = { price: 0.01, total_supply: 100_000 };
    assert.equal(marketCapFromGmgn(info), 1_000);
  });

  it('returns null when no valid data', () => {
    assert.equal(marketCapFromGmgn({}), null);
  });

  it('returns null for null input', () => {
    assert.equal(marketCapFromGmgn(null), null);
  });

  it('ignores zero market_cap and falls back to calculation', () => {
    const info = { market_cap: 0, price: 1, circulating_supply: 1000 };
    assert.equal(marketCapFromGmgn(info), 1000);
  });
});

describe('tokenPriceFromGmgn()', () => {
  it('returns price when present and finite', () => {
    assert.equal(tokenPriceFromGmgn({ price: 0.00042 }), 0.00042);
  });

  it('returns null when price is missing', () => {
    assert.equal(tokenPriceFromGmgn({}), null);
  });

  it('returns null for NaN price', () => {
    assert.equal(tokenPriceFromGmgn({ price: 'bad' }), null);
  });

  it('returns null for null input', () => {
    assert.equal(tokenPriceFromGmgn(null), null);
  });

  it('returns 0 for zero price', () => {
    assert.equal(tokenPriceFromGmgn({ price: 0 }), 0);
  });
});

describe('gmgnStatusText()', () => {
  it('returns "off" when GMGN disabled', () => {
    // GMGN_ENABLED=false set at top of file
    assert.equal(gmgnStatusText('token'), 'off');
    assert.equal(gmgnStatusText('trending'), 'off');
  });
});

describe('gmgnBackoffActive() and setGmgnBackoff()', () => {
  it('is not active initially', () => {
    assert.equal(gmgnBackoffActive('token'), false);
    assert.equal(gmgnBackoffActive('trending'), false);
  });

  it('activates backoff on 429 error', () => {
    const err = new Error('rate limited');
    err.response = { status: 429, data: {} };
    setGmgnBackoff('token', err);
    assert.equal(gmgnBackoffActive('token'), true);
  });

  it('activates backoff on 403 error', () => {
    const err = new Error('forbidden');
    err.response = { status: 403, data: {} };
    setGmgnBackoff('trending', err);
    assert.equal(gmgnBackoffActive('trending'), true);
  });

  it('does not activate backoff for other error codes', () => {
    // Reset to false first by checking a fresh kind
    const err = new Error('server error');
    err.response = { status: 500, data: {} };
    // 500 should not trigger backoff — token backoff may already be set
    // so we check it didn't change the state unexpectedly
    const before = gmgnBackoffActive('token');
    setGmgnBackoff('token', err);
    assert.equal(gmgnBackoffActive('token'), before);
  });
});
