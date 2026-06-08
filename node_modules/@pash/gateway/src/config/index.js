'use strict';

/**
 * Gateway Configuration
 * All values from environment variables with explicit defaults and validation.
 */

function required(name) {
  const val = process.env[name];
  if (!val && process.env.NODE_ENV === 'production') {
    throw new Error(`Required env var ${name} is not set`);
  }
  return val ?? '';
}

function optional(name, defaultVal) {
  return process.env[name] ?? defaultVal;
}

const config = {
  env:  optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '3000'), 10),
  host: optional('HOST', '0.0.0.0'),

  // ─── Database ──────────────────────────────────────────────────────────────
  db: {
    url:         optional('DATABASE_URL', 'postgres://pash:pash@localhost:5432/pash_gateway'),
    poolMin:     parseInt(optional('DB_POOL_MIN', '2'), 10),
    poolMax:     parseInt(optional('DB_POOL_MAX', '20'), 10),
  },

  // ─── Redis ─────────────────────────────────────────────────────────────────
  redis: {
    url:         optional('REDIS_URL', 'redis://localhost:6379'),
    keyPrefix:   optional('REDIS_PREFIX', 'pash:'),
  },

  // ─── Upstream Providers ────────────────────────────────────────────────────
  providers: {
    openrouter: {
      baseUrl:  'https://openrouter.ai/api/v1',
      apiKey:   optional('OPENROUTER_API_KEY', ''),
    },
    openai: {
      baseUrl:  'https://api.openai.com/v1',
      apiKey:   optional('OPENAI_API_KEY', ''),
    },
    anthropic: {
      baseUrl:  'https://api.anthropic.com/v1',
      apiKey:   optional('ANTHROPIC_API_KEY', ''),
    },
  },

  // ─── PASH Prompt Injection ─────────────────────────────────────────────────
  prompt: {
    // FIX: PASH block must be IDENTICAL across all requests for Prompt Caching.
    // It is placed at the BEGINNING of the system message.
    // Per-provider strategy is applied separately in prompt-injector.js
    placement:    optional('PASH_PROMPT_PLACEMENT', 'prefix'), // prefix | suffix
    lang:         optional('PASH_PROMPT_LANG', 'ru'),
    mode:         optional('PASH_PROMPT_MODE', 'pash'),        // pash | pash+id | events
  },

  // ─── Rate Limiting ─────────────────────────────────────────────────────────
  rateLimit: {
    // FIX: Gateway-level rate limiting was missing from original plan
    perKeyRpm:    parseInt(optional('RATE_LIMIT_PER_KEY_RPM', '60'), 10),
    perIpRpm:     parseInt(optional('RATE_LIMIT_PER_IP_RPM', '10'), 10),
  },

  // ─── Circuit Breaker ───────────────────────────────────────────────────────
  circuitBreaker: {
    failureThreshold: parseInt(optional('CB_FAILURE_THRESHOLD', '5'), 10),
    resetTimeoutMs:   parseInt(optional('CB_RESET_TIMEOUT_MS', '30000'), 10),
    // Fallback providers in priority order
    providerChain:    optional('CB_PROVIDER_CHAIN', 'openrouter,openai').split(','),
  },

  // ─── Streaming ─────────────────────────────────────────────────────────────
  streaming: {
    upstreamTimeoutMs:    parseInt(optional('UPSTREAM_TIMEOUT_MS', '30000'), 10),
    maxLinesPerRequest:   parseInt(optional('MAX_LINES_PER_REQUEST', '500'), 10),
    snapshotIntervalLines: parseInt(optional('SNAPSHOT_INTERVAL', '50'), 10),
  },

  // ─── Session Snapshots ─────────────────────────────────────────────────────
  sessions: {
    // FIX: snapshots stored in Redis, not in-process memory
    snapshotTtlMs: parseInt(optional('SNAPSHOT_TTL_MS', String(30 * 60 * 1000)), 10),
  },

  // ─── Security ──────────────────────────────────────────────────────────────
  security: {
    // FIX: Provider API keys must NEVER appear in logs
    logProviderKeys: false,
    maskKeyLength:   4, // show only first N chars of keys in logs
  },

  // ─── CORS ──────────────────────────────────────────────────────────────────
  cors: {
    // FIX: CORS was missing from original plan
    origin:  optional('CORS_ORIGIN', '*'),
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  },
};

module.exports = config;
