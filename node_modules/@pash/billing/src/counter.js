'use strict';

/**
 * BillingCounter — distributed line counter backed by Redis.
 *
 * FIX (audit #4): Line count was in-process memory → broken under horizontal scaling.
 * Solution: all increments go through Redis INCR which is atomic.
 *
 * FIX (audit #6): Pre-check before request — check limit BEFORE sending to provider.
 * Solution: checkLimit() must be called before initiating upstream fetch.
 *
 * FIX (audit #11): Mid-stream limit enforcement — emit special SSE event, close stream.
 * Solution: StreamGuard class wraps line counting and calls abort on limit.
 */

const REDIS_KEY_PREFIX   = 'pash:lines:';
const REDIS_TTL_SECONDS  = 86400 * 32; // 32 days rolling window

class BillingCounter {
  /**
   * @param {Object} redis - ioredis or compatible client
   */
  constructor(redis) {
    if (!redis) throw new Error('BillingCounter: redis client required');
    this._redis = redis;
  }

  _key(orgId) {
    return `${REDIS_KEY_PREFIX}${orgId}`;
  }

  /**
   * Get current line count for an org.
   */
  async getCount(orgId) {
    const val = await this._redis.get(this._key(orgId));
    return parseInt(val ?? '0', 10);
  }

  /**
   * Atomically increment and return new total.
   */
  async increment(orgId, delta = 1) {
    const key     = this._key(orgId);
    const newVal  = await this._redis.incrby(key, delta);
    // Reset TTL on every write (sliding window)
    await this._redis.expire(key, REDIS_TTL_SECONDS);
    return newVal;
  }

  /**
   * PRE-CHECK: verify org has budget before initiating upstream request.
   * FIX: Must be called before fetch() to avoid paying for over-limit requests.
   *
   * @param {string} orgId
   * @param {number} limit - org's monthly line limit
   * @returns {{ allowed: boolean, current: number, remaining: number }}
   */
  async checkLimit(orgId, limit) {
    const current   = await this.getCount(orgId);
    const remaining = Math.max(0, limit - current);
    return {
      allowed:   current < limit,
      current,
      remaining,
      limit,
    };
  }

  /**
   * Reset counter (for testing / billing cycle rollover).
   */
  async reset(orgId) {
    await this._redis.del(this._key(orgId));
  }
}

/**
 * StreamGuard — wraps a streaming response, counts PASH lines,
 * and enforces limit mid-stream.
 *
 * FIX (audit #11): When limit is hit mid-stream, sends a structured
 * error event and closes the stream instead of silent disconnect.
 *
 * @example
 *   const guard = new StreamGuard({ orgId, limit, counter, onLimitExceeded });
 *   for await (const chunk of upstreamStream) {
 *     const { lines, shouldStop } = guard.push(chunk);
 *     if (shouldStop) break;
 *     yield chunk;
 *   }
 */
class StreamGuard {
  constructor({ orgId, limit, currentCount, batchSize = 50 }) {
    this.orgId        = orgId;
    this.limit        = limit;
    this._current     = currentCount;
    this._sessionLines = 0;
    this._batchSize   = batchSize;
    this._buffer      = '';
    this._stopped     = false;
  }

  /**
   * Process a chunk of streaming text.
   * Counts completed PASH lines (only valid MOUNT/UPDATE/UNMOUNT ops).
   *
   * FIX (audit #5): Count only valid PASH component lines, not every \n.
   * We use operator char detection for fast-path counting.
   *
   * @returns {{ newLines: number, totalSession: number, shouldStop: boolean, limitLine?: string }}
   */
  push(chunk) {
    if (this._stopped) return { newLines: 0, totalSession: this._sessionLines, shouldStop: true };

    this._buffer += chunk;
    const lines   = this._buffer.split('\n');
    this._buffer  = lines.pop(); // last may be incomplete

    let newLines = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && ['+', '~', '-'].includes(trimmed[0])) {
        newLines++;
      }
    }

    this._sessionLines  += newLines;
    this._current       += newLines;

    if (this._current >= this.limit) {
      this._stopped = true;
      return {
        newLines,
        totalSession: this._sessionLines,
        shouldStop:   true,
        limitLine:    `data: ${JSON.stringify({
          error:     'PASH_LIMIT_EXCEEDED',
          lines_used: this._current,
          limit:      this.limit,
          message:    'Monthly PASH line limit reached. Upgrade your plan.',
        })}\n\n`,
      };
    }

    return { newLines, totalSession: this._sessionLines, shouldStop: false };
  }

  /** Call at end of stream to get final count */
  flush() {
    // Count any remaining content in buffer
    const trimmed = this._buffer.trim();
    if (trimmed && ['+', '~', '-'].includes(trimmed[0])) {
      this._sessionLines++;
      this._current++;
    }
    this._buffer = '';
    return this._sessionLines;
  }

  get sessionLines() { return this._sessionLines; }
  get stopped()      { return this._stopped; }
}

module.exports = { BillingCounter, StreamGuard };
