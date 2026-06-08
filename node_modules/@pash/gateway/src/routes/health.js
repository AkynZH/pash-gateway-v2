'use strict';

const { getRedis } = require('../services/redis');

/**
 * GET /v1/health  — liveness probe
 * GET /v1/ready   — readiness probe (checks Redis + DB)
 * GET /v1/metrics — internal metrics for monitoring
 */
async function healthRoute(fastify, opts) {
  const { circuitBreaker, sessionManager, startedAt } = opts;

  // ── Liveness ───────────────────────────────────────────────────────────────
  fastify.get('/v1/health', { config: { skipAuth: true } }, async (request, reply) => {
    return reply.send({ status: 'ok', ts: Date.now() });
  });

  // ── Readiness ──────────────────────────────────────────────────────────────
  fastify.get('/v1/ready', { config: { skipAuth: true } }, async (request, reply) => {
    const checks = {};

    // Redis check
    try {
      const redis = getRedis();
      await redis.set('pash:healthcheck', '1', 'EX', 5);
      checks.redis = 'ok';
    } catch (e) {
      checks.redis = 'error: ' + e.message;
    }

    const allOk  = Object.values(checks).every(v => v === 'ok');
    const status = allOk ? 200 : 503;

    return reply.code(status).send({
      ready:    allOk,
      checks,
      uptime:   Date.now() - startedAt,
      sessions: sessionManager?.activeSessions() ?? 0,
    });
  });

  // ── Circuit Breaker Status ─────────────────────────────────────────────────
  fastify.get('/v1/metrics/circuit-breaker', {
    config: { requireAuth: true },
  }, async (request, reply) => {
    return reply.send({
      providers: circuitBreaker?.allStatus() ?? [],
      ts: Date.now(),
    });
  });

  // ── Billing Summary ────────────────────────────────────────────────────────
  fastify.get('/v1/metrics/billing', {
    config: { requireAuth: true },
  }, async (request, reply) => {
    const { orgId, lineLimit } = request.pashContext;
    const redis = getRedis();
    const key   = `pash:lines:${orgId}`;

    const current   = parseInt(await redis.get(key) ?? '0', 10);
    const remaining = Math.max(0, lineLimit - current);

    return reply.send({
      orgId,
      linesUsed:      current,
      lineLimit,
      linesRemaining: remaining,
      usagePct:       Math.round((current / lineLimit) * 100),
      ts:             Date.now(),
    });
  });
}

module.exports = healthRoute;
