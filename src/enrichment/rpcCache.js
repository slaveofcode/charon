/**
 * Simple TTL cache for RPC and API results.
 * Prevents redundant queries within the cache window.
 */
export class RpcCache {
  constructor(defaultTtlMs = 300_000) {
    this.cache = new Map();
    this.defaultTtlMs = defaultTtlMs;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  clear() {
    this.cache.clear();
  }

  /** Auto-clean stale entries */
  prune() {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) this.cache.delete(key);
    }
  }
}

/** Global singleton for wallet data */
export const walletCache = new RpcCache(300_000);
