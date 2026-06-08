'use strict';

describe('Observability package', () => {
  test('exports metrics and register', () => {
    const { register, metrics } = require('../src');
    expect(register).toBeDefined();
    expect(metrics.pashOpsTotal).toBeDefined();
    expect(metrics.pashSecurityBlocksTotal).toBeDefined();
    expect(metrics.pashSessionResumesTotal).toBeDefined();
    expect(metrics.pashRequestDuration).toBeDefined();
  });
});
