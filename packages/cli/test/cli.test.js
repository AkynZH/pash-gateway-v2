'use strict';

const { checkSchema, consistencyScore } = require('../src');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('PASH CLI', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pash-cli-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('checkSchema', () => {
    test('passes when schemas are identical', async () => {
      const schema = { components: { Button: { fields: { label: 'string' }, required: ['label'] } } };
      const oldFile = path.join(tempDir, 'old.json');
      const newFile = path.join(tempDir, 'new.json');
      fs.writeFileSync(oldFile, JSON.stringify(schema));
      fs.writeFileSync(newFile, JSON.stringify(schema));

      const result = await checkSchema(oldFile, newFile);
      expect(result.hasBreakingChanges).toBe(false);
      expect(result.breakingChanges).toHaveLength(0);
    });

    test('fails when a field is removed', async () => {
      const oldSchema = { components: { Button: { fields: { label: 'string', icon: 'string' } } } };
      const newSchema = { components: { Button: { fields: { label: 'string' } } } };
      const oldFile = path.join(tempDir, 'old.json');
      const newFile = path.join(tempDir, 'new.json');
      fs.writeFileSync(oldFile, JSON.stringify(oldSchema));
      fs.writeFileSync(newFile, JSON.stringify(newSchema));

      const result = await checkSchema(oldFile, newFile);
      expect(result.hasBreakingChanges).toBe(true);
      expect(result.breakingChanges).toContain("Field 'icon' was removed from component 'Button'.");
    });

    test('fails when a field type changes', async () => {
      const oldSchema = { components: { Button: { fields: { count: 'number' } } } };
      const newSchema = { components: { Button: { fields: { count: 'string' } } } };
      const oldFile = path.join(tempDir, 'old.json');
      const newFile = path.join(tempDir, 'new.json');
      fs.writeFileSync(oldFile, JSON.stringify(oldSchema));
      fs.writeFileSync(newFile, JSON.stringify(newSchema));

      const result = await checkSchema(oldFile, newFile);
      expect(result.hasBreakingChanges).toBe(true);
      expect(result.breakingChanges).toContain("Field 'count' in component 'Button' changed type from 'number' to 'string'.");
    });
  });

  describe('consistencyScore', () => {
    test('returns high score for deterministic output (temp 0)', async () => {
      const promptFile = path.join(tempDir, 'prompt.txt');
      fs.writeFileSync(promptFile, 'Generate a PASH UI for a user profile');

      const result = await consistencyScore(promptFile, 50, 0.0);
      expect(result.totalRuns).toBe(50);
      expect(result.score).toBe(1.0);
    });

    test('returns lower score for high variance (temp 1.0)', async () => {
      const promptFile = path.join(tempDir, 'prompt.txt');
      fs.writeFileSync(promptFile, 'Generate a PASH UI for a user profile');

      // Mock Math.random to force variance for testing
      const originalRandom = Math.random;
      Math.random = () => 0.05; // Always below 0.1, so always varying

      const result = await consistencyScore(promptFile, 50, 1.0);
      
      Math.random = originalRandom;

      // With 10% variation chance per run, score should be less than 1.0
      // Actually, our mock forces variation, so each run might be unique or clustered
      expect(result.totalRuns).toBe(50);
      expect(result.score).toBeLessThan(1.0);
    });
  });
});
