import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Point DB to a temp file before importing connection
const tmpDir = mkdtempSync(join(tmpdir(), 'charon-test-'));
const tmpDb = join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDb;

// Dynamic import so env var is set first
const { db, initDb, ensureColumn } = await import('../src/db/connection.js');

describe('initDb()', () => {
  before(() => {
    initDb();
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the settings table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert.ok(tables.includes('settings'));
  });

  it('creates the candidates table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert.ok(tables.includes('candidates'));
  });

  it('creates the dry_run_positions table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert.ok(tables.includes('dry_run_positions'));
  });

  it('creates the trade_intents table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert.ok(tables.includes('trade_intents'));
  });

  it('creates the strategies table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert.ok(tables.includes('strategies'));
  });

  it('seeds default strategies', () => {
    const strategies = db.prepare('SELECT id FROM strategies').all().map(r => r.id);
    assert.ok(strategies.includes('sniper'));
    assert.ok(strategies.includes('dip_buy'));
    assert.ok(strategies.includes('smart_money'));
    assert.ok(strategies.includes('degen'));
  });

  it('seeds default settings', () => {
    const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('trading_mode');
    assert.ok(setting !== undefined);
  });

  it('is idempotent — can be called multiple times without error', () => {
    assert.doesNotThrow(() => initDb());
  });

  it('uses WAL journal mode', () => {
    const row = db.pragma('journal_mode', { simple: true });
    assert.equal(row, 'wal');
  });
});

describe('ensureColumn()', () => {
  it('adds a column that does not exist', () => {
    ensureColumn('settings', 'test_col', 'TEXT');
    const cols = db.prepare('PRAGMA table_info(settings)').all().map(r => r.name);
    assert.ok(cols.includes('test_col'));
  });

  it('does not throw when column already exists', () => {
    ensureColumn('settings', 'key', 'TEXT');
    assert.doesNotThrow(() => ensureColumn('settings', 'key', 'TEXT'));
  });
});
