'use strict';

const { SchemaStore } = require('@pash/registry');
const { getRedis } = require('../services/redis');

/**
 * GET /v1/schemas/:componentName
 * POST /v1/schemas
 * DELETE /v1/schemas/:componentName/:version
 *
 * Dynamic Schema Registry API.
 * Allows clients to register, query, and manage component schemas for Pass 2 validation.
 * OrgId is extracted from request.pashContext (set by auth middleware).
 */
async function schemaRoutes(fastify, opts) {

  // Helper to get org-scoped store
  const getStore = (request) => {
    const orgId = request.pashContext?.orgId || 'global';
    return new SchemaStore(getRedis(), orgId);
  };

  // ── Register new schema ─────────────────────────────────────────────────────
  fastify.post('/v1/schemas', {
    config: { requireAuth: true },
    schema: {
      body: {
        type: 'object',
        required: ['componentName', 'version', 'schema'],
        properties: {
          componentName: { type: 'string', pattern: '^[A-Z][a-zA-Z0-9]*$' },
          version: { type: 'integer', minimum: 1 },
          schema: {
            type: 'object',
            required: ['fields'],
            properties: {
              fields: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['label', 'type'],
                  properties: {
                    label: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_]*$' },
                    type: { type: 'string', enum: ['string', 'number', 'enum', 'boolean'] },
                    required: { type: 'boolean' },
                    values: { type: 'array', items: { type: 'string' } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { componentName, version, schema } = request.body;
    const store = getStore(request);
    
    try {
      const result = await store.register(componentName, version, schema);
      return reply.code(201).send({ success: true, ...result });
    } catch (err) {
      return reply.code(400).send({ error: 'INVALID_SCHEMA', message: err.message });
    }
  });

  // ── Get latest schema for component ────────────────────────────────────────
  fastify.get('/v1/schemas/:componentName', {
    config: { requireAuth: true }
  }, async (request, reply) => {
    const { componentName } = request.params;
    const store = getStore(request);
    
    const latest = await store.getLatest(componentName);
    if (!latest) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: `Component ${componentName} not registered` });
    }
    
    return reply.send({ componentName, latest });
  });

  // ── Get specific version ───────────────────────────────────────────────────
  fastify.get('/v1/schemas/:componentName/:version', {
    config: { requireAuth: true }
  }, async (request, reply) => {
    const { componentName, version } = request.params;
    const store = getStore(request);
    const v = parseInt(version, 10);
    
    const schema = await store.get(componentName, v);
    if (!schema) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: `Version ${v} of ${componentName} not found` });
    }
    
    return reply.send({ componentName, version: v, schema });
  });

  // ── List all versions ─────────────────────────────────────────────────────
  fastify.get('/v1/schemas/:componentName/versions', {
    config: { requireAuth: true }
  }, async (request, reply) => {
    const { componentName } = request.params;
    const store = getStore(request);
    
    const versions = await store.listVersions(componentName);
    return reply.send({ componentName, versions, count: versions.length });
  });

  // ── Delete specific version ────────────────────────────────────────────────
  fastify.delete('/v1/schemas/:componentName/:version', {
    config: { requireAuth: true }
  }, async (request, reply) => {
    const { componentName, version } = request.params;
    const store = getStore(request);
    const v = parseInt(version, 10);
    
    try {
      await store.delete(componentName, v);
      return reply.send({ success: true, componentName, version: v });
    } catch (err) {
      return reply.code(500).send({ error: 'DELETE_FAILED', message: err.message });
    }
  });
}

module.exports = schemaRoutes;