'use strict';

const { SecurityPipeline } = require('../src/pipeline');

describe('SecurityPipeline', () => {
  let pipeline;

  beforeEach(() => {
    pipeline = new SecurityPipeline({ strictMode: true });
  });

  describe('XSS Detection', () => {
    test('blocks script tags', () => {
      expect(() => pipeline.inspect('<script>alert(1)</script>')).toThrow('SECURITY_VIOLATION: XSS vector detected');
    });

    test('blocks javascript: protocol', () => {
      expect(() => pipeline.inspect('javascript:alert(1)')).toThrow('SECURITY_VIOLATION: XSS vector detected');
    });

    test('blocks event handlers', () => {
      expect(() => pipeline.inspect('<img src=x onerror=alert(1)>')).toThrow('SECURITY_VIOLATION: XSS vector detected');
    });

    test('blocks iframe tags', () => {
      expect(() => pipeline.inspect('<iframe src="evil.com"></iframe>')).toThrow('SECURITY_VIOLATION: XSS vector detected');
    });
  });

  describe('Secrets Detection', () => {
    test('blocks Stripe-like API keys', () => {
      expect(() => pipeline.inspect('My key is sk_live_1234567890abcdef12345678')).toThrow('SECURITY_VIOLATION: Sensitive data pattern detected');
    });

    test('blocks GitHub tokens', () => {
      expect(() => pipeline.inspect('Token: ghp_1234567890abcdefghijklmnopqrstuvwxyz')).toThrow('SECURITY_VIOLATION: Sensitive data pattern detected');
    });

    test('blocks credit card patterns', () => {
      expect(() => pipeline.inspect('Card: 4111-1111-1111-1111')).toThrow('SECURITY_VIOLATION: Sensitive data pattern detected');
    });
  });

  describe('Object and Array Traversal', () => {
    test('inspects nested objects', () => {
      const safeObj = { name: 'John', details: { role: 'admin' } };
      expect(pipeline.inspect(safeObj)).toEqual(safeObj);

      const maliciousObj = { name: 'John', payload: '<script>evil()</script>' };
      expect(() => pipeline.inspect(maliciousObj)).toThrow('SECURITY_VIOLATION: XSS vector detected');
    });

    test('inspects arrays', () => {
      const safeArr = ['item1', 'item2'];
      expect(pipeline.inspect(safeArr)).toEqual(safeArr);

      const maliciousArr = ['safe', 'sk_test_12345678901234567890'];
      expect(() => pipeline.inspect(maliciousArr)).toThrow('SECURITY_VIOLATION: Sensitive data pattern detected');
    });
  });

  describe('Non-strict Mode (Redaction)', () => {
    let nonStrictPipeline;

    beforeEach(() => {
      nonStrictPipeline = new SecurityPipeline({ strictMode: false, redactChar: '[REDACTED]' });
    });

    test('redacts secrets instead of throwing', () => {
      const result = nonStrictPipeline.inspect('My key is sk_live_1234567890abcdef12345678');
      expect(result).toBe('My key is [REDACTED]');
    });

    test('sanitizes HTML', () => {
      const result = nonStrictPipeline.sanitize('<script>alert(1)</script>');
      expect(result).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    });
  });
});
