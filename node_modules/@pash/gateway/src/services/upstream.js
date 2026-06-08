'use strict';

const config = require('../config');

/**
 * UpstreamClient — sends requests to LLM providers.
 *
 * FIX (audit #13): AbortSignal.timeout prevents hanging connections.
 * FIX (audit #10): Client disconnect aborts upstream to stop token billing.
 * FIX (audit #14): Retry logic for non-streaming requests on 5xx.
 * FIX (audit #1):  Provider API keys never appear in logs.
 */

const PROVIDER_URLS = {
  openrouter:  'https://openrouter.ai/api/v1/chat/completions',
  openai:      'https://api.openai.com/v1/chat/completions',
  anthropic:   'https://api.anthropic.com/v1/messages',
};

class UpstreamClient {
  /**
   * @param {Object} opts
   * @param {string} opts.providerApiKey - client's BYOK key or our master key
   * @param {string} opts.providerName   - 'openrouter' | 'openai' | 'anthropic'
   */
  constructor({ providerApiKey, providerName = 'openrouter' }) {
    if (!providerApiKey) throw new Error('UpstreamClient: providerApiKey required');
    // FIX: never log the key
    this._key      = providerApiKey;
    this._provider = providerName;
    this._url      = PROVIDER_URLS[providerName] ?? PROVIDER_URLS.openrouter;
  }

  /**
   * Send a streaming request.
   * Returns the raw Response object for stream piping.
   *
   * @param {Object}       body            - full request body (messages, model, etc.)
   * @param {AbortSignal}  clientSignal    - abort when client disconnects
   * @returns {Promise<Response>}
   */
  async fetchStream(body, clientSignal) {
    const streamBody = { ...body, stream: true };

    // FIX: Combined abort — either client disconnect OR timeout
    const timeoutSignal = AbortSignal.timeout(config.streaming.upstreamTimeoutMs);
    const combined      = anySignal([clientSignal, timeoutSignal].filter(Boolean));

    const headers = this._buildHeaders();

    const response = await fetch(this._url, {
      method:  'POST',
      headers,
      body:    JSON.stringify(streamBody),
      signal:  combined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new UpstreamError(response.status, text, this._provider);
    }

    return response;
  }

  /**
   * Send a non-streaming request with retry.
   * FIX (audit #14): exponential backoff on 5xx.
   */
  async fetchSync(body, retries = 3) {
    const syncBody = { ...body, stream: false };
    const headers  = this._buildHeaders();

    for (let attempt = 0; attempt <= retries; attempt++) {
      const signal = AbortSignal.timeout(config.streaming.upstreamTimeoutMs);

      try {
        const response = await fetch(this._url, {
          method:  'POST',
          headers,
          body:    JSON.stringify(syncBody),
          signal,
        });

        if (response.status >= 500 && attempt < retries) {
          const delay = 200 * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new UpstreamError(response.status, text, this._provider);
        }

        return await response.json();
      } catch (err) {
        if (attempt === retries || err instanceof UpstreamError) throw err;
        await sleep(200 * Math.pow(2, attempt));
      }
    }
  }

  _buildHeaders() {
    const headers = {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${this._key}`,
    };

    // OpenRouter-specific headers
    if (this._provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://pash-gateway.com';
      headers['X-Title']      = 'PASH Gateway';
    }

    return headers;
  }
}

class UpstreamError extends Error {
  constructor(status, body, provider) {
    super(`Upstream ${provider} error ${status}: ${body.slice(0, 200)}`);
    this.status   = status;
    this.provider = provider;
    this.upstream = true;
  }
}

/** Polyfill for AbortSignal.any() combining multiple signals */
function anySignal(signals) {
  if (!signals.length) return undefined;
  if (signals.length === 1) return signals[0];

  const controller = new AbortController();

  function abort(reason) {
    if (!controller.signal.aborted) controller.abort(reason);
  }

  for (const sig of signals) {
    if (sig.aborted) { abort(sig.reason); break; }
    sig.addEventListener('abort', () => abort(sig.reason), { once: true });
  }

  return controller.signal;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { UpstreamClient, UpstreamError };
