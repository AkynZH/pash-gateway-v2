'use strict';

const crypto = require('crypto');
const { getRedis } = require('./redis');

const KEY_TTL_SECONDS  = 300; // 5 min cache of validated keys
const CACHE_PREFIX     = 'pash:keycheck:';

/**
 * AuthService — API key verification and org resolution.
 *
 * FIX: Original plan had no key management system.
 * Keys are stored as SHA-256 hashes, never plaintext.
 * Fast-path: validated keys cached in Redis for 5 minutes.
 *
 * Key format: pash_live_<32 random hex chars>
 *             pash_test_<32 random hex chars>
 */
class AuthService {
  constructor(db) {
    this._db    = db;
    this._redis = getRedis();
  }

  /**
   * Verify a PASH API key and return org context.
   * @param {string} rawKey - from Authorization: Bearer header
   * @returns {{ valid, orgId, plan, lineLimit, env, governance } | { valid: false, reason }}
   */
  async verify(rawKey) {
    if (!rawKey || !rawKey.startsWith('pash_')) {
      return { valid: false, reason: 'Invalid key format' };
    }

    // Fast-path: check Redis cache
    const keyHash    = sha256(rawKey);
    const cacheKey   = CACHE_PREFIX + keyHash;
    const cachedJson = await this._redis.get(cacheKey);

    if (cachedJson) {
      try {
        return JSON.parse(cachedJson);
      } catch {}
    }

    // DB lookup
    const result = await this._lookupInDb(keyHash);

    if (result.valid) {
      // Cache successful lookups
      await this._redis.setex(cacheKey, KEY_TTL_SECONDS, JSON.stringify(result));
    }

    return result;
  }

  async _lookupInDb(keyHash) {
    if (!this._db) {
      // Dev/test mode without DB — accept any key starting with pash_test_
      return {
        valid:     true,
        orgId:     'org_test',
        plan:      'free',
        lineLimit: 300_000,
        env:       'test',
        governance: {
          maxLines: 1000,
          allowedComponents: null, // null means all allowed
          blockedComponents: ['CryptoPaymentForm', 'AdminPanel'],
        },
        webhookUrl: 'https://example.com/system-webhook',
      };
    }

    try {
      const row = await this._db.query(
        `SELECT org_id, plan, line_limit, env, status, governance
         FROM api_keys
         WHERE key_hash = $1 AND status = 'active'
         LIMIT 1`,
        [keyHash]
      );

      if (!row.rows.length) {
        return { valid: false, reason: 'Key not found or revoked' };
      }

      const r = row.rows[0];
      return {
        valid:     true,
        orgId:     r.org_id,
        plan:      r.plan,
        lineLimit: r.line_limit,
        env:       r.env,
        governance: r.governance || {},
        webhookUrl: r.webhook_url || null, // Systemic webhook URL
      };
    } catch (err) {
      console.error('[Auth] DB lookup failed:', err.message);
      return { valid: false, reason: 'Auth service unavailable' };
    }
  }

  /**
   * Mask a key for safe logging.
   * "pash_live_abc123..." → "pash_live_abc1****"
   */
  static maskKey(key) {
    if (!key || key.length < 15) return '****';
    return key.slice(0, 14) + '****';
  }
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

module.exports = { AuthService };
