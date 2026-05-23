import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  now,
  safeJson,
  json,
  sleep,
  stripThinking,
  pruneSeen,
  firstPositiveNumber,
  lamToSol,
  discMatch,
  parseNumericInput,
  parseWindowMs,
  formatWindow,
  makeFailureTracker,
  strictJsonFromText,
  base58Encode,
  parseDistFees,
  readU64,
} from '../src/utils.js';

describe('now()', () => {
  it('returns a number close to Date.now()', () => {
    const before = Date.now();
    const result = now();
    const after = Date.now();
    assert.ok(result >= before && result <= after);
  });
});

describe('safeJson()', () => {
  it('parses valid JSON object', () => {
    assert.deepEqual(safeJson('{"a":1}'), { a: 1 });
  });

  it('parses valid JSON array', () => {
    assert.deepEqual(safeJson('[1,2,3]'), [1, 2, 3]);
  });

  it('returns null fallback for invalid JSON', () => {
    assert.equal(safeJson('not-json'), null);
  });

  it('returns custom fallback for invalid JSON', () => {
    assert.equal(safeJson('bad', 42), 42);
  });

  it('returns null for empty string', () => {
    assert.equal(safeJson(''), null);
  });
});

describe('json()', () => {
  it('stringifies objects', () => {
    assert.equal(json({ a: 1 }), '{"a":1}');
  });

  it('stringifies null as "null"', () => {
    assert.equal(json(null), 'null');
  });

  it('stringifies undefined as "null"', () => {
    assert.equal(json(undefined), 'null');
  });

  it('stringifies arrays', () => {
    assert.equal(json([1, 2]), '[1,2]');
  });
});

describe('sleep()', () => {
  it('resolves after given delay', async () => {
    const start = Date.now();
    await sleep(50);
    assert.ok(Date.now() - start >= 45);
  });

  it('returns a Promise', () => {
    const p = sleep(1);
    assert.ok(p instanceof Promise);
    return p;
  });
});

describe('stripThinking()', () => {
  it('strips full <think> blocks', () => {
    assert.equal(stripThinking('<think>internal</think>answer'), 'answer');
  });

  it('strips multiline <think> blocks', () => {
    assert.equal(stripThinking('<think>\nline1\nline2\n</think>result'), 'result');
  });

  it('strips unclosed <think> opening tag, leaving remaining text', () => {
    assert.equal(stripThinking('<think>only'), 'only');
  });

  it('returns original text when no think tags', () => {
    assert.equal(stripThinking('plain text'), 'plain text');
  });

  it('handles empty string', () => {
    assert.equal(stripThinking(''), '');
  });

  it('handles null/undefined gracefully', () => {
    assert.equal(stripThinking(null), '');
    assert.equal(stripThinking(undefined), '');
  });
});

describe('pruneSeen()', () => {
  it('removes entries older than ttl', () => {
    const map = new Map();
    map.set('old', Date.now() - 10_000);
    map.set('new', Date.now());
    pruneSeen(map, 5_000);
    assert.ok(!map.has('old'));
    assert.ok(map.has('new'));
  });

  it('keeps entries within ttl', () => {
    const map = new Map();
    map.set('recent', Date.now() - 1_000);
    pruneSeen(map, 5_000);
    assert.ok(map.has('recent'));
  });

  it('handles empty map', () => {
    const map = new Map();
    assert.doesNotThrow(() => pruneSeen(map, 1000));
  });
});

describe('firstPositiveNumber()', () => {
  it('returns first positive number from arguments', () => {
    assert.equal(firstPositiveNumber(0, -1, 5, 10), 5);
  });

  it('ignores zero and negative values', () => {
    assert.equal(firstPositiveNumber(0, -5, 3), 3);
  });

  it('returns null when no positive number found', () => {
    assert.equal(firstPositiveNumber(0, -1, null, undefined), null);
  });

  it('handles string numbers', () => {
    assert.equal(firstPositiveNumber('42'), 42);
  });

  it('ignores NaN and non-finite values', () => {
    assert.equal(firstPositiveNumber(NaN, Infinity, 7), 7);
  });

  it('returns null with no arguments', () => {
    assert.equal(firstPositiveNumber(), null);
  });
});

describe('lamToSol()', () => {
  it('converts lamports to SOL', () => {
    assert.equal(lamToSol(1_000_000_000), 1);
  });

  it('converts fractional SOL', () => {
    assert.equal(lamToSol(500_000_000), 0.5);
  });

  it('handles BigInt lamports', () => {
    assert.equal(lamToSol(1_000_000_000n), 1);
  });

  it('handles 0', () => {
    assert.equal(lamToSol(0), 0);
  });
});

describe('discMatch()', () => {
  it('returns true when buffer starts with discriminator', () => {
    const buf = Buffer.from([0xA5, 0x37, 0x81, 0x70, 0x04, 0xB3, 0xCA, 0x28, 0xFF]);
    const disc = [0xA5, 0x37, 0x81, 0x70, 0x04, 0xB3, 0xCA, 0x28];
    assert.equal(discMatch(buf, disc), true);
  });

  it('returns false when discriminator does not match', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const disc = [0xFF, 0xFE];
    assert.equal(discMatch(buf, disc), false);
  });

  it('returns true for empty discriminator', () => {
    const buf = Buffer.from([1, 2, 3]);
    assert.equal(discMatch(buf, []), true);
  });
});

describe('parseNumericInput()', () => {
  it('parses plain integers', () => {
    assert.equal(parseNumericInput('42'), 42);
  });

  it('parses decimal numbers', () => {
    assert.equal(parseNumericInput('3.14'), 3.14);
  });

  it('parses negative numbers', () => {
    assert.equal(parseNumericInput('-25'), -25);
  });

  it('parses k suffix (thousands)', () => {
    assert.equal(parseNumericInput('10k'), 10_000);
  });

  it('parses m suffix (millions)', () => {
    assert.equal(parseNumericInput('2m'), 2_000_000);
  });

  it('parses b suffix (billions)', () => {
    assert.equal(parseNumericInput('1b'), 1_000_000_000);
  });

  it('strips $ and % symbols', () => {
    assert.equal(parseNumericInput('$100'), 100);
    assert.equal(parseNumericInput('50%'), 50);
  });

  it('strips commas and underscores', () => {
    assert.equal(parseNumericInput('1,000'), 1000);
  });

  it('returns 0 for "off"', () => {
    assert.equal(parseNumericInput('off'), 0);
  });

  it('returns 0 for "none"', () => {
    assert.equal(parseNumericInput('none'), 0);
  });

  it('returns 0 for "disable"', () => {
    assert.equal(parseNumericInput('disable'), 0);
  });

  it('returns null for non-numeric input', () => {
    assert.equal(parseNumericInput('abc'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseNumericInput(''), null);
  });

  it('handles uppercase suffixes', () => {
    assert.equal(parseNumericInput('5K'), 5_000);
    assert.equal(parseNumericInput('2M'), 2_000_000);
  });
});

describe('parseWindowMs()', () => {
  it('parses hours', () => {
    assert.equal(parseWindowMs('1h'), 60 * 60 * 1000);
  });

  it('parses minutes', () => {
    assert.equal(parseWindowMs('30m'), 30 * 60 * 1000);
  });

  it('parses days', () => {
    assert.equal(parseWindowMs('1d'), 24 * 60 * 60 * 1000);
  });

  it('defaults to 12h when invalid', () => {
    assert.equal(parseWindowMs('invalid'), 12 * 60 * 60 * 1000);
  });

  it('defaults to 12h when empty', () => {
    assert.equal(parseWindowMs(''), 12 * 60 * 60 * 1000);
  });

  it('defaults to 12h when undefined', () => {
    assert.equal(parseWindowMs(), 12 * 60 * 60 * 1000);
  });

  it('clamps to minimum 5 minutes', () => {
    assert.equal(parseWindowMs('1m'), 5 * 60 * 1000);
  });

  it('clamps to maximum 30 days', () => {
    const maxMs = 30 * 24 * 60 * 60 * 1000;
    assert.equal(parseWindowMs('100d'), maxMs);
  });
});

describe('formatWindow()', () => {
  it('formats full days', () => {
    assert.equal(formatWindow(24 * 60 * 60 * 1000), '1d');
  });

  it('formats full hours', () => {
    assert.equal(formatWindow(2 * 60 * 60 * 1000), '2h');
  });

  it('formats minutes for non-round hours', () => {
    assert.equal(formatWindow(90 * 60 * 1000), '90m');
  });
});

describe('makeFailureTracker()', () => {
  it('calls fn successfully and resets count', async () => {
    let alertCalled = false;
    const tracker = makeFailureTracker('test', () => { alertCalled = true; return Promise.resolve(); }, 3);
    await tracker(() => Promise.resolve());
    await tracker(() => Promise.resolve());
    assert.equal(alertCalled, false);
  });

  it('alerts when failure threshold is reached', async () => {
    let alertMessage = null;
    const tracker = makeFailureTracker('svc', (msg) => { alertMessage = msg; return Promise.resolve(); }, 2);
    await tracker(() => Promise.reject(new Error('fail1')));
    await tracker(() => Promise.reject(new Error('fail2')));
    assert.ok(alertMessage !== null);
    assert.ok(alertMessage.includes('svc'));
  });

  it('resets failure count after alerting', async () => {
    let alertCount = 0;
    const tracker = makeFailureTracker('svc', () => { alertCount++; return Promise.resolve(); }, 2);
    // First threshold hit
    await tracker(() => Promise.reject(new Error('x')));
    await tracker(() => Promise.reject(new Error('x')));
    assert.equal(alertCount, 1);
    // Second threshold hit
    await tracker(() => Promise.reject(new Error('x')));
    await tracker(() => Promise.reject(new Error('x')));
    assert.equal(alertCount, 2);
  });

  it('resets count on success after failures', async () => {
    let alertCalled = false;
    const tracker = makeFailureTracker('svc', () => { alertCalled = true; return Promise.resolve(); }, 3);
    await tracker(() => Promise.reject(new Error('fail')));
    await tracker(() => Promise.reject(new Error('fail')));
    await tracker(() => Promise.resolve()); // success resets
    await tracker(() => Promise.reject(new Error('fail')));
    await tracker(() => Promise.reject(new Error('fail')));
    assert.equal(alertCalled, false); // threshold not reached again
  });
});

describe('strictJsonFromText()', () => {
  it('parses fenced JSON code blocks', () => {
    const text = '```json\n{"key":"value"}\n```';
    assert.deepEqual(strictJsonFromText(text), { key: 'value' });
  });

  it('parses bare JSON object from text', () => {
    const text = 'Some prefix {"key":"value"} some suffix';
    assert.deepEqual(strictJsonFromText(text), { key: 'value' });
  });

  it('strips <think> blocks before parsing', () => {
    const text = '<think>internal reasoning</think>{"result":true}';
    assert.deepEqual(strictJsonFromText(text), { result: true });
  });

  it('throws on invalid JSON', () => {
    assert.throws(() => strictJsonFromText('not json at all'), SyntaxError);
  });
});

describe('base58Encode()', () => {
  it('encodes empty bytes to leading-zero symbol "1"', () => {
    assert.equal(base58Encode(Buffer.from([])), '1');
  });

  it('encodes known byte sequence consistently', () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const encoded = base58Encode(bytes);
    assert.equal(typeof encoded, 'string');
    assert.ok(encoded.length > 0);
  });

  it('only uses base58 alphabet characters', () => {
    const alphabet = new Set('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');
    const bytes = Buffer.from([10, 20, 30, 40]);
    const encoded = base58Encode(bytes);
    for (const ch of encoded) {
      assert.ok(alphabet.has(ch), `unexpected char: ${ch}`);
    }
  });
});
