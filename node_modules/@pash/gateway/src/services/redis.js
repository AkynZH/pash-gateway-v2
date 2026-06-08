'use strict';

const config = require('../config');

let _client = null;

/**
 * Get or create Redis client.
 * In test environment returns an in-memory mock.
 */
function getRedis() {
  if (_client) return _client;

  if (config.env === 'test') {
    _client = createMemoryRedis();
    return _client;
  }

  try {
    const Redis = require('ioredis');
    _client = new Redis(config.redis.url, {
      keyPrefix:    config.redis.keyPrefix,
      lazyConnect:  true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });

    _client.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });
  } catch (e) {
    console.warn('[Redis] ioredis not available, using memory fallback');
    _client = createMemoryRedis();
  }

  return _client;
}

/**
 * In-memory Redis mock for tests and development without Redis.
 * Implements only the commands used by the gateway.
 */
function createMemoryRedis() {
  const store   = new Map();
  const expires = new Map();

  function checkExpiry(key) {
    const exp = expires.get(key);
    if (exp && Date.now() > exp) {
      store.delete(key);
      expires.delete(key);
      return true;
    }
    return false;
  }

  return {
    async get(key) {
      if (checkExpiry(key)) return null;
      return store.get(key) ?? null;
    },
    async set(key, value, ...args) {
      store.set(key, String(value));
      // Handle SET key value EX seconds
      const exIdx = args.indexOf('EX');
      if (exIdx !== -1) {
        expires.set(key, Date.now() + parseInt(args[exIdx + 1], 10) * 1000);
      }
      return 'OK';
    },
    async incrby(key, delta) {
      if (checkExpiry(key)) store.delete(key);
      const cur = parseInt(store.get(key) ?? '0', 10);
      const next = cur + delta;
      store.set(key, String(next));
      return next;
    },
    async incr(key) { return this.incrby(key, 1); },
    async expire(key, seconds) {
      if (store.has(key)) expires.set(key, Date.now() + seconds * 1000);
      return 1;
    },
    async del(key) { store.delete(key); expires.delete(key); return 1; },
    async hset(key, ...args) {
      if (!store.has(key)) store.set(key, {});
      const obj = store.get(key);
      for (let i = 0; i < args.length; i += 2) obj[args[i]] = args[i + 1];
      return 1;
    },
    async hgetall(key) {
      if (checkExpiry(key)) return null;
      return store.get(key) ?? null;
    },
    async setex(key, seconds, value) {
      store.set(key, String(value));
      expires.set(key, Date.now() + seconds * 1000);
      return 'OK';
    },
    on() { return this; },
    disconnect() {},
    // For testing
    _store: store,
  };
}

module.exports = { getRedis };
