'use strict';

const client = require('prom-client');

// Create a Registry which registers the metrics
const register = new client.Registry();

// Add default metrics (CPU, memory, event loop)
client.collectDefaultMetrics({ register });

// ─── Custom PASH Metrics ─────────────────────────────────────────────────────

const pashOpsTotal = new client.Counter({
  name: 'pash_operations_total',
  help: 'Total number of PASH v2 operations applied to the ComponentTree',
  labelNames: ['operation', 'component'], // operation: 'mount', 'update', 'unmount'
  registers: [register],
});

const pashSecurityBlocksTotal = new client.Counter({
  name: 'pash_security_blocks_total',
  help: 'Total number of requests blocked by the SecurityPipeline',
  labelNames: ['reason'], // reason: 'xss', 'secrets'
  registers: [register],
});

const pashSessionResumesTotal = new client.Counter({
  name: 'pash_session_resumes_total',
  help: 'Total number of successful session resume handshakes',
  registers: [register],
});

const pashRequestDuration = new client.Histogram({
  name: 'pash_request_duration_seconds',
  help: 'Duration of PASH gateway requests in seconds',
  labelNames: ['route', 'method', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

module.exports = {
  register,
  metrics: {
    pashOpsTotal,
    pashSecurityBlocksTotal,
    pashSessionResumesTotal,
    pashRequestDuration,
  },
};
