'use strict';

const { register } = require('@pash/observability');

/**
 * GET /metrics
 * Prometheus-compatible metrics endpoint.
 * Auth is intentionally skipped for internal scraping (can be restricted by network rules).
 */
async function metricsRoute(fastify, opts) {
  fastify.get('/metrics', {
    config: { skipAuth: true },
    schema: {
      response: {
        200: { type: 'string' }
      }
    }
  }, async (request, reply) => {
    reply.type(register.contentType);
    return register.metrics();
  });
}

module.exports = metricsRoute;
