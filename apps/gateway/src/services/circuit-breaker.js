'use strict';

/**
 * CircuitBreaker — manages provider failover.
 *
 * FIX (audit #4 / circuit breaker): When switching provider mid-stream,
 * the new provider MUST receive the PASH system prompt.
 * The breaker emits a re-injection signal on failover.
 *
 * States: CLOSED → OPEN → HALF_OPEN → CLOSED
 *
 * Provider chain: configured in config.circuitBreaker.providerChain
 * e.g. ['openrouter', 'openai', 'anthropic']
 */

const STATE = Object.freeze({
  CLOSED:    'CLOSED',    // Normal operation
  OPEN:      'OPEN',      // Failing, reject requests
  HALF_OPEN: 'HALF_OPEN', // Testing recovery
});

class ProviderCircuit {
  constructor(name, { failureThreshold = 5, resetTimeoutMs = 30_000 } = {}) {
    this.name             = name;
    this.state            = STATE.CLOSED;
    this.failures         = 0;
    this.successes        = 0;
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs   = resetTimeoutMs;
    this.openedAt         = null;
    this.lastError        = null;
  }

  isAvailable() {
    if (this.state === STATE.CLOSED)    return true;
    if (this.state === STATE.HALF_OPEN) return true;
    // OPEN: check if reset timeout elapsed
    if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = STATE.HALF_OPEN;
      return true;
    }
    return false;
  }

  recordSuccess() {
    this.failures  = 0;
    this.successes++;
    if (this.state === STATE.HALF_OPEN) {
      this.state = STATE.CLOSED;
      console.log(`[CircuitBreaker] ${this.name}: HALF_OPEN → CLOSED (recovered)`);
    }
  }

  recordFailure(err) {
    this.failures++;
    this.lastError = err?.message;

    if (this.failures >= this.failureThreshold && this.state === STATE.CLOSED) {
      this.state    = STATE.OPEN;
      this.openedAt = Date.now();
      console.warn(`[CircuitBreaker] ${this.name}: CLOSED → OPEN after ${this.failures} failures`);
    } else if (this.state === STATE.HALF_OPEN) {
      this.state    = STATE.OPEN;
      this.openedAt = Date.now();
      console.warn(`[CircuitBreaker] ${this.name}: HALF_OPEN → OPEN (probe failed)`);
    }
  }

  toJSON() {
    return { name: this.name, state: this.state, failures: this.failures,
             openedAt: this.openedAt, lastError: this.lastError };
  }
}

class CircuitBreakerManager {
  /**
   * @param {string[]} providerChain  - ordered list of provider names
   * @param {Object}   opts
   */
  constructor(providerChain, opts = {}) {
    this._opts    = opts;
    this._circuit = new Map();

    for (const name of providerChain) {
      this._circuit.set(name, new ProviderCircuit(name, opts));
    }

    this._chain = providerChain;
  }

  /**
   * Get the next available provider.
   * Returns null if all providers are OPEN.
   */
  getAvailable(preferredProvider = null) {
    // Try preferred first
    if (preferredProvider) {
      const c = this._circuit.get(preferredProvider);
      if (c?.isAvailable()) return preferredProvider;
    }

    // Walk the chain
    for (const name of this._chain) {
      const c = this._circuit.get(name);
      if (c?.isAvailable()) return name;
    }

    return null;
  }

  recordSuccess(providerName) {
    this._circuit.get(providerName)?.recordSuccess();
  }

  recordFailure(providerName, err) {
    this._circuit.get(providerName)?.recordFailure(err);
  }

  allStatus() {
    return Array.from(this._circuit.values()).map(c => c.toJSON());
  }

  /**
   * Execute a request with automatic failover.
   *
   * FIX: On failover, the onFailover callback is invoked so the caller
   * can re-inject the PASH system prompt into the new request.
   *
   * @param {function(providerName: string): Promise} fn
   * @param {function(newProvider: string): void} onFailover
   * @returns {Promise}
   */
  async executeWithFailover(fn, onFailover) {
    const tried = new Set();

    while (true) {
      const provider = this.getAvailable();
      if (!provider || tried.has(provider)) {
        throw new Error('All providers unavailable (circuit open)');
      }
      tried.add(provider);

      try {
        const result = await fn(provider);
        this.recordSuccess(provider);
        return result;
      } catch (err) {
        this.recordFailure(provider, err);
        console.warn(`[CircuitBreaker] ${provider} failed: ${err.message}. Trying next...`);

        // FIX: Signal failover so prompt can be re-injected
        const next = this.getAvailable();
        if (next && next !== provider) {
          console.log(`[CircuitBreaker] Failing over to ${next}. Re-injecting PASH prompt.`);
          onFailover?.(next);
        }
        // Continue loop to try next provider
      }
    }
  }
}

module.exports = { CircuitBreakerManager, ProviderCircuit, STATE };
