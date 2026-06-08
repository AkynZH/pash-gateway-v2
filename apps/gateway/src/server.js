'use strict';

const Fastify                  = require('fastify');
const config                   = require('./config');
const { buildAuthMiddleware }  = require('./middleware/auth');
const { CircuitBreakerManager }= require('./services/circuit-breaker');
const { PromptInjector, buildStaticPashBlock } = require('./services/prompt-injector');
const { SessionManager }       = require('@pash/state-engine');
const { SchemaResolver }       = require('@pash/state-engine');
const { BillingCounter }       = require('@pash/billing');
const { getRedis }             = require('./services/redis');
const completionsRoute         = require('./routes/completions');
const presentationRoute        = require('./routes/presentation');
const healthRoute              = require('./routes/health');
const schemasRoute             = require('./routes/schemas');
const metricsRoute             = require('./routes/metrics');
const { metrics: obsMetrics }  = require('@pash/observability');

const startedAt = Date.now();

/**
 * Build and configure the Fastify application.
 * Exported as a function so it can be used in tests without side effects.
 */
async function buildApp(db = null) {
  const app = Fastify({
    logger: {
      level:      config.env === 'test' ? 'silent' : 'info',
      redact:     ['req.headers.authorization', 'req.headers["x-pash-provider-key"]'],
    },
    trustProxy: true,
  });

  // ── Plugins ────────────────────────────────────────────────────────────────

  // CORS — FIX: was missing from original plan
  await app.register(require('@fastify/cors'), {
    origin:  config.cors.origin,
    methods: config.cors.methods,
  });

  // Rate limiting — FIX: was missing from original plan
  await app.register(require('@fastify/rate-limit'), {
    global:  false, // apply per-route via config
    redis:   config.env !== 'test' ? getRedis() : null,
    max:     config.rateLimit.perKeyRpm,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      return request.pashContext?.orgId
        ?? request.ip
        ?? 'anon';
    },
    errorResponseBuilder: () => ({
      error:   'RATE_LIMIT_EXCEEDED',
      message: `Max ${config.rateLimit.perKeyRpm} requests per minute`,
    }),
  });

  // ── Services (singletons) ──────────────────────────────────────────────────

  const circuitBreaker = new CircuitBreakerManager(
    config.circuitBreaker.providerChain,
    {
      failureThreshold: config.circuitBreaker.failureThreshold,
      resetTimeoutMs:   config.circuitBreaker.resetTimeoutMs,
    }
  );

  // Base schemas — seed with pash-sdk SCHEMAS if available
  const baseSchemas = new SchemaResolver();
  try {
    const { SCHEMAS } = require('pash-sdk');
    for (const [id, schema] of Object.entries(SCHEMAS)) {
      baseSchemas.register(schema.name, schema.v ?? 1, schema);
    }
    app.log.info(`[Server] Loaded ${Object.keys(SCHEMAS).length} base schemas from pash-sdk`);
  } catch {
    app.log.warn('[Server] pash-sdk not available — using empty base schemas');
  }

  // Build PASH prompt block ONCE at startup (static = cacheable by LLM providers)
  let pashBlock;
  try {
    const { SCHEMAS } = require('pash-sdk');
    pashBlock = buildStaticPashBlock(SCHEMAS, {
      lang: config.prompt.lang,
      mode: config.prompt.mode,
    });
  } catch {
    pashBlock = 'You generate UI in PASH v2 format. Use +[id]|Component|fields operators.';
  }

  const injector = new PromptInjector({
    pashBlock,
    placement: config.prompt.placement,
  });

  // Session manager backed by Redis snapshots
  const redis = getRedis();
  const sessionManager = new SessionManager({
    snapshotTtlMs: config.sessions.snapshotTtlMs,
    snapshotStore: buildRedisSnapshotStore(redis),
    lineCounter:   new BillingCounter(redis),
  });

  app.log.info('[Server] Services initialized');

  // ── Auth middleware (global preHandler) ────────────────────────────────────
  const authMiddleware = buildAuthMiddleware(db);

  app.addHook('preHandler', async (request, reply) => {
    // Skip auth for routes that opt out
    if (request.routeOptions?.config?.skipAuth) return;
    return authMiddleware(request, reply);
  });

  // ── Routes ─────────────────────────────────────────────────────────────────
  const routeOpts = { circuitBreaker, injector, sessionManager, baseSchemas, startedAt };

  await app.register(schemasRoute,      routeOpts);
  await app.register(healthRoute,       routeOpts);
  await app.register(completionsRoute,  routeOpts);
  await app.register(presentationRoute, routeOpts);
  await app.register(metricsRoute,      routeOpts);

  // ── Observability: Track request duration ─────────────────────────────────
  app.addHook('onRequest', (request, reply, done) => {
    request.pashStartTime = process.hrtime();
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    if (request.pashStartTime) {
      const diff = process.hrtime(request.pashStartTime);
      const duration = diff[0] + diff[1] / 1e9;
      obsMetrics.pashRequestDuration.observe(
        { route: request.routerPath, method: request.method, status: reply.statusCode },
        duration
      );
    }
    done();
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal) => {
    app.log.info(`[Server] ${signal} received — shutting down`);
    await app.close();
    process.exit(0);
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT',  () => shutdown('SIGINT'));

  return app;
}

/**
 * Redis-backed snapshot store for SessionManager.
 * Key: pash:snapshot:<sessionId>
 */
function buildRedisSnapshotStore(redis) {
  return {
    async save(sessionId, snapshot, ttlMs) {
      const key = `pash:snapshot:${sessionId}`;
      const ttlSeconds = Math.ceil(ttlMs / 1000);
      await redis.setex(key, ttlSeconds, JSON.stringify(snapshot));
    },
    async load(sessionId) {
      const key  = `pash:snapshot:${sessionId}`;
      const json = await redis.get(key);
      if (!json) return null;
      try { return JSON.parse(json); } catch { return null; }
    },
  };
}

// ── Start server if run directly ───────────────────────────────────────────────
if (require.main === module) {
  buildApp()
    .then(async (app) => {
      await app.listen({ port: config.port, host: config.host });
      app.log.info(`[Server] PASH Gateway v2 listening on ${config.host}:${config.port}`);
      app.log.info(`[Server] Environment: ${config.env}`);
    })
    .catch((err) => {
      console.error('[Server] Fatal startup error:', err);
      process.exit(1);
    });
}

module.exports = { buildApp };
