'use strict';

const { SchemaStore } = require('../src/schema-store');

// Simple in-memory Redis mock for testing
function createMockRedis() {
  const store = new Map();
  const expires = new Map();

  function checkExpiry(key) {
    const exp = expires.get(key);
    if (exp && Date.now() > exp) {
      store.delete(key);
      expires.delete(key);
      return true;
    }
    return false;
  }

  return {
    async hset(key, field, value) {
      if (!store.has(key)) store.set(key, {});
      const obj = store.get(key);
      obj[field] = value;
      return 1;
    },
    async hget(key, field) {
      if (checkExpiry(key)) return null;
      const obj = store.get(key);
      return obj ? obj[field] : null;
    },
    async get(key) {
      if (checkExpiry(key)) return null;
      return store.get(key) ?? null;
    },
    async setex(key, seconds, value) {
      store.set(key, value);
      expires.set(key, Date.now() + seconds * 1000);
      return 'OK';
    },
    async expire(key, seconds) {
      if (store.has(key)) {
        expires.set(key, Date.now() + seconds * 1000);
      }
      return 1;
    },
    async del(key) {
      store.delete(key);
      expires.delete(key);
      return 1;
    },
    async scan(...args) {
      // ioredis scan signature: scan(cursor, 'MATCH', pattern, 'COUNT', count)
      // We extract the pattern and count from args
      let cursor = args[0];
      let pattern = '*';
      let count = 100;
      
      for (let i = 1; i < args.length; i++) {
        if (args[i] === 'MATCH' && args[i+1]) {
          pattern = args[i+1];
        }
        if (args[i] === 'COUNT' && args[i+1]) {
          count = args[i+1];
        }
      }

      const regex = new RegExp('^' + pattern.replace('*', '.*') + '$');
      const keys = [];
      for (const key of store.keys()) {
        if (regex.test(key)) keys.push(key);
      }
      return ['0', keys]; // '0' means done
    }
  };
}

describe('SchemaStore', () => {
  let redis;
  let store;

  beforeEach(() => {
    redis = createMockRedis();
    store = new SchemaStore(redis, 'test-org');
  });

  test('register and get latest schema', async () => {
    const schema = { fields: [{ label: 'title', type: 'string', required: true }] };
    await store.register('UserCard', 1, schema);
    
    const result = await store.getLatest('UserCard');
    expect(result).not.toBeNull();
    expect(result._component).toBe('UserCard');
    expect(result._version).toBe(1);
    expect(result.fields[0].label).toBe('title');
  });

  test('register higher version updates latest', async () => {
    await store.register('UserCard', 1, { fields: [] });
    await store.register('UserCard', 2, { fields: [{ label: 'name', type: 'string' }] });
    
    const latest = await store.getLatest('UserCard');
    expect(latest._version).toBe(2);
    
    const v1 = await store.get('UserCard', 1);
    expect(v1._version).toBe(1);
  });

  test('list versions returns sorted array', async () => {
    await store.register('Card', 3, { fields: [] });
    await store.register('Card', 1, { fields: [] });
    await store.register('Card', 2, { fields: [] });
    
    const versions = await store.listVersions('Card');
    expect(versions).toHaveLength(3);
    expect(versions[0]._version).toBe(3);
    expect(versions[1]._version).toBe(2);
    expect(versions[2]._version).toBe(1);
  });

  test('delete schema version and recalculate latest', async () => {
    await store.register('Widget', 1, { fields: [] });
    await store.register('Widget', 2, { fields: [] });
    
    await store.delete('Widget', 2);
    
    const latest = await store.getLatest('Widget');
    expect(latest._version).toBe(1);
    
    const v2 = await store.get('Widget', 2);
    expect(v2).toBeNull();
  });

  test('rejects invalid component name', async () => {
    await expect(store.register('invalid_name', 1, { fields: [] }))
      .rejects.toThrow('Invalid component name');
      
    await expect(store.register('123Component', 1, { fields: [] }))
      .rejects.toThrow('Invalid component name');
  });

  test('rejects schema without fields array', async () => {
    await expect(store.register('ValidName', 1, { notFields: true }))
      .rejects.toThrow('Invalid schema: must contain "fields" array');
  });
});