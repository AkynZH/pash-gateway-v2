'use strict';

const { SchemaResolver } = require('../src/schema-resolver');

const V1 = { fields: [
  { label: 'title', type: 'string', required: true },
  { label: 'price', type: 'number', format: 'currency' },
]};

const V2 = { fields: [
  { label: 'title',               type: 'string', required: true },
  { label: 'price',               type: 'number', format: 'currency' },
  { label: 'sustainability_score', type: 'number' },
  { label: 'carbon_footprint',    type: 'string' },
]};

describe('SchemaResolver', () => {
  test('exact version — no warn', () => {
    const r = new SchemaResolver();
    r.register('ProductCard', 1, V1);
    r.register('ProductCard', 2, V2);
    const { warnLine, actualVersion } = r.resolve('ProductCard', 2);
    expect(actualVersion).toBe(2);
    expect(warnLine).toBeNull();
  });

  test('downgrade v3→v2 emits !warn', () => {
    const r = new SchemaResolver();
    r.register('ProductCard', 1, V1);
    r.register('ProductCard', 2, V2);
    const { warnLine, actualVersion } = r.resolve('ProductCard', 3, 'card_1');
    expect(actualVersion).toBe(2);
    expect(warnLine).toMatch(/^!warn\|/);
    expect(warnLine).toContain('card_1');
  });

  test('unknown component → null schema no throw', () => {
    const r = new SchemaResolver();
    const { schema } = r.resolve('Ghost', 1, 'x');
    expect(schema).toBeNull();
  });

  test('resolveLatest returns highest', () => {
    const r = new SchemaResolver();
    r.register('B', 1, { fields: [] });
    r.register('B', 3, { fields: [] });
    r.register('B', 2, { fields: [] });
    expect(r.resolveLatest('B')._version).toBe(3);
  });

  test('negotiateCapabilities: unknown → warning not rejection', () => {
    const r = new SchemaResolver();
    const { valid, warnings } = r.negotiateCapabilities([{ name: 'GhostWidget', version: 1 }]);
    expect(valid).toBe(true);
    expect(warnings[0]).toMatch(/Unknown component/);
  });

  test('negotiateCapabilities: degraded flag set on downgrade', () => {
    const r = new SchemaResolver();
    r.register('ProductCard', 1, V1);
    const { negotiated } = r.negotiateCapabilities([{ name: 'ProductCard', version: 3 }]);
    expect(negotiated[0].degraded).toBe(true);
    expect(negotiated[0].actualVersion).toBe(1);
  });
});
