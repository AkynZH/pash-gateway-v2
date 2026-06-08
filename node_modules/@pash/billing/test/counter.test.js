'use strict';

const { BillingCounter, StreamGuard } = require('../src/counter');

function makeRedis() {
  const store = new Map();
  return {
    async get(k)          { return store.get(k) ?? null; },
    async set(k, v)       { store.set(k, String(v)); return 'OK'; },
    async incrby(k, d)    {
      const n = parseInt(store.get(k) ?? '0', 10) + d;
      store.set(k, String(n)); return n;
    },
    async expire()        { return 1; },
    async del(k)          { store.delete(k); return 1; },
    async setex(k, s, v)  { store.set(k, String(v)); return 'OK'; },
    _store: store,
  };
}

describe('BillingCounter', () => {
  test('increment and getCount', async () => {
    const redis   = makeRedis();
    const counter = new BillingCounter(redis);
    await counter.increment('org1', 10);
    await counter.increment('org1', 5);
    expect(await counter.getCount('org1')).toBe(15);
  });

  test('checkLimit: allowed below limit', async () => {
    const redis   = makeRedis();
    const counter = new BillingCounter(redis);
    const r = await counter.checkLimit('org2', 100);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(100);
  });

  test('checkLimit: denied at limit', async () => {
    const redis   = makeRedis();
    const counter = new BillingCounter(redis);
    await counter.increment('org3', 100);
    const r = await counter.checkLimit('org3', 100);
    expect(r.allowed).toBe(false);
  });

  test('reset clears counter', async () => {
    const redis   = makeRedis();
    const counter = new BillingCounter(redis);
    await counter.increment('org4', 50);
    await counter.reset('org4');
    expect(await counter.getCount('org4')).toBe(0);
  });
});

describe('StreamGuard', () => {
  test('counts + ~ - lines only', () => {
    const g = new StreamGuard({ orgId: 'x', limit: 1000, currentCount: 0 });
    const { newLines } = g.push('+[a]|X|y\n~[a]|f|v\n-[a]\nplain text line\n@version|...\n');
    expect(newLines).toBe(3);
  });

  test('partial line held in buffer', () => {
    const g = new StreamGuard({ orgId: 'x', limit: 1000, currentCount: 0 });
    g.push('+[a]|X');   // incomplete
    const r = g.push('|y\n');  // completed
    expect(r.newLines).toBe(1);
  });

  test('limit exceeded mid-stream', () => {
    const g = new StreamGuard({ orgId: 'x', limit: 3, currentCount: 2 });
    const r = g.push('+[a]|X|y\n+[b]|X|y\n');
    expect(r.shouldStop).toBe(true);
    expect(r.limitLine).toContain('PASH_LIMIT_EXCEEDED');
    expect(r.limitLine).toContain('lines_used');
  });

  test('flush counts last incomplete line', () => {
    const g = new StreamGuard({ orgId: 'x', limit: 100, currentCount: 0 });
    g.push('+[a]|X|y');  // no trailing \n
    const total = g.flush();
    expect(total).toBe(1);
  });

  test('stopped guard ignores further chunks', () => {
    const g = new StreamGuard({ orgId: 'x', limit: 1, currentCount: 0 });
    g.push('+[a]|X|y\n');
    expect(g.stopped).toBe(true);
    const r = g.push('+[b]|X|y\n');
    expect(r.shouldStop).toBe(true);
    expect(r.newLines).toBe(0);
  });
});
