'use strict';

/**
 * SchemaStore — Redis-backed dynamic schema registry.
 * 
 * FIX (audit): Allows clients/orgs to register custom component schemas.
 * The gateway caches them in Redis for distributed validation (Pass 2).
 * 
 * Key structure: pash:schema:{orgId}:{componentName}:v{version}
 */

class SchemaStore {
  /**
   * @param {Object} redis - ioredis or compatible client
   * @param {string} orgId - tenant/org identifier (default: 'global')
   */
  constructor(redis, orgId = 'global') {
    if (!redis) throw new Error('SchemaStore: redis client required');
    this._redis = redis;
    this._orgId = orgId;
    this._prefix = `pash:schema:${orgId}:`;
    this._ttlSeconds = 86400 * 30; // 30 days rolling TTL
  }

  /**
   * Register or update a component schema.
   * @param {string} componentName - PascalCase name (e.g., 'UserCard')
   * @param {number} version - schema version (e.g., 1, 2)
   * @param {Object} schema - { fields: [{ label, type, required, values? }], metadata? }
   */
  async register(componentName, version, schema) {
    if (!/^[A-Z][a-zA-Z0-9]*$/.test(componentName)) {
      throw new Error(`Invalid component name: ${componentName} (must be PascalCase)`);
    }
    if (!schema || !Array.isArray(schema.fields)) {
      throw new Error('Invalid schema: must contain "fields" array');
    }

    const key = `${this._prefix}${componentName}:v${version}`;
    await this._redis.hset(key, 'data', JSON.stringify(schema));
    await this._redis.expire(key, this._ttlSeconds);
    
    // Update latest version index
    const latestKey = `${this._prefix}${componentName}:latest`;
    const currentLatest = await this._redis.get(latestKey);
    if (!currentLatest || parseInt(currentLatest, 10) < version) {
      await this._redis.setex(latestKey, this._ttlSeconds, String(version));
    }

    return { componentName, version, success: true };
  }

  /**
   * Get a specific version of a schema.
   * @returns {Object|null}
   */
  async get(componentName, version) {
    const key = `${this._prefix}${componentName}:v${version}`;
    const data = await this._redis.hget(key, 'data');
    if (!data) return null;
    
    try {
      const parsed = JSON.parse(data);
      parsed._version = version;
      parsed._component = componentName;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Get the latest version of a schema.
   * @returns {Object|null}
   */
  async getLatest(componentName) {
    const latestKey = `${this._prefix}${componentName}:latest`;
    const versionStr = await this._redis.get(latestKey);
    if (!versionStr) return null;
    
    return this.get(componentName, parseInt(versionStr, 10));
  }

  /**
   * List all registered versions of a component (ordered desc).
   * @returns {Object[]}
   */
  async listVersions(componentName) {
    // Use SCAN for production safety instead of KEYS
    const pattern = `${this._prefix}${componentName}:v*`;
    const versions = [];
    let cursor = '0';
    
    do {
      const [nextCursor, keys] = await this._redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      
      for (const key of keys) {
        const data = await this._redis.hget(key, 'data');
        if (data) {
          try {
            const parsed = JSON.parse(data);
            const vMatch = key.match(/:v(\d+)$/);
            parsed._version = vMatch ? parseInt(vMatch[1], 10) : 1;
            parsed._component = componentName;
            versions.push(parsed);
          } catch {
            // ignore corrupted
          }
        }
      }
    } while (cursor !== '0');

    return versions.sort((a, b) => b._version - a._version);
  }

  /**
   * Delete a specific schema version.
   */
  async delete(componentName, version) {
    const key = `${this._prefix}${componentName}:v${version}`;
    await this._redis.del(key);
    
    // Recalculate latest if needed
    const latestKey = `${this._prefix}${componentName}:latest`;
    const currentLatest = await this._redis.get(latestKey);
    if (currentLatest === String(version)) {
      const versions = await this.listVersions(componentName);
      if (versions.length > 0) {
        await this._redis.setex(latestKey, this._ttlSeconds, String(versions[0]._version));
      } else {
        await this._redis.del(latestKey);
      }
    }
    
    return { success: true };
  }
}

module.exports = { SchemaStore };