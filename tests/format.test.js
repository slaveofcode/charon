import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  short,
  fmtSol,
  fmtUsd,
  fmtPct,
  gmgnLink,
  txLink,
  accountLink,
} from '../src/format.js';

describe('escapeHtml()', () => {
  it('escapes ampersands', () => {
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
  });

  it('escapes less-than', () => {
    assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  });

  it('escapes both < and >', () => {
    assert.equal(escapeHtml('<b>bold</b>'), '&lt;b&gt;bold&lt;/b&gt;');
  });

  it('returns empty string for null', () => {
    assert.equal(escapeHtml(null), '');
  });

  it('returns empty string for undefined', () => {
    assert.equal(escapeHtml(undefined), '');
  });

  it('leaves safe text unchanged', () => {
    assert.equal(escapeHtml('hello world'), 'hello world');
  });
});

describe('short()', () => {
  it('shortens a long address to first 6 + last 4 chars', () => {
    const addr = 'So11111111111111111111111111111111111111112';
    assert.equal(short(addr), 'So1111...1112');
  });

  it('format is always first6...last4', () => {
    const addr = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const result = short(addr);
    assert.ok(result.startsWith('ABCDEF'));
    assert.ok(result.endsWith('WXYZ'));
    assert.ok(result.includes('...'));
  });
});

describe('fmtSol()', () => {
  it('formats to 4 decimal places', () => {
    assert.equal(fmtSol(1.5), '1.5000');
  });

  it('formats zero', () => {
    assert.equal(fmtSol(0), '0.0000');
  });

  it('returns "?" for non-finite values', () => {
    assert.equal(fmtSol(NaN), '?');
    assert.equal(fmtSol(Infinity), '?');
    assert.equal(fmtSol(undefined), '?');
  });

  it('handles string numbers', () => {
    assert.equal(fmtSol('0.5'), '0.5000');
  });
});

describe('fmtUsd()', () => {
  it('formats values under $1K with dollar sign', () => {
    assert.equal(fmtUsd(500), '$500');
  });

  it('formats values in thousands as K', () => {
    assert.equal(fmtUsd(1500), '$1.5K');
  });

  it('formats values in millions as M', () => {
    assert.equal(fmtUsd(2_500_000), '$2.5M');
  });

  it('returns "?" for non-finite values', () => {
    assert.equal(fmtUsd(NaN), '?');
    assert.equal(fmtUsd(undefined), '?');
  });

  it('formats 0 as $0', () => {
    assert.equal(fmtUsd(0), '$0');
  });
});

describe('fmtPct()', () => {
  it('formats percentage with 1 decimal', () => {
    assert.equal(fmtPct(12.5), '12.5%');
  });

  it('formats negative percentage', () => {
    assert.equal(fmtPct(-33.3), '-33.3%');
  });

  it('formats zero', () => {
    assert.equal(fmtPct(0), '0.0%');
  });

  it('returns "?" for non-finite values', () => {
    assert.equal(fmtPct(NaN), '?');
    assert.equal(fmtPct(undefined), '?');
  });
});

describe('gmgnLink()', () => {
  it('returns correct GMGN URL for a mint', () => {
    const mint = 'So11111111111111111111111111111111111111112';
    assert.equal(gmgnLink(mint), `https://gmgn.ai/sol/token/${mint}`);
  });
});

describe('txLink()', () => {
  it('returns correct Solscan transaction URL', () => {
    const sig = 'abc123def456';
    assert.equal(txLink(sig), `https://solscan.io/tx/${sig}`);
  });
});

describe('accountLink()', () => {
  it('returns correct Solscan account URL', () => {
    const addr = 'So11111111111111111111111111111111111111112';
    assert.equal(accountLink(addr), `https://solscan.io/account/${addr}`);
  });
});
