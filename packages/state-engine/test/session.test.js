'use strict';

const { SessionManager } = require('../src/session');

describe('SessionManager', () => {
  let sessions;
  let mockSnapshotStore;
  let mockLineCounter;

  beforeEach(() => {
    mockSnapshotStore = {
      save: jest.fn().mockResolvedValue(undefined),
      load: jest.fn().mockResolvedValue(null),
    };
    mockLineCounter = {
      increment: jest.fn().mockResolvedValue(undefined),
    };

    sessions = new SessionManager({
      snapshotStore: mockSnapshotStore,
      lineCounter: mockLineCounter,
      snapshotTtlMs: 1000 * 60 * 30, // 30 minutes
    });
  });

  describe('create', () => {
    test('creates a session with all required properties including webhookUrl', () => {
      const session = sessions.create({
        orgId: 'org_123',
        apiKeyId: 'key_456',
        clientSchemas: [{ name: 'ProductCard', version: 1 }],
        webhookUrl: 'https://example.com/webhook',
      });

      expect(session.id).toMatch(/^sess_[0-9a-f]{32}$/);
      expect(session.orgId).toBe('org_123');
      expect(session.apiKeyId).toBe('key_456');
      expect(session.webhookUrl).toBe('https://example.com/webhook');
      expect(session.tree).toBeDefined();
      expect(session.resolver).toBeDefined();
      expect(session.lineCount).toBe(0);
    });
  });

  describe('close', () => {
    test('triggers webhook on session close if webhookUrl is present', async () => {
      const session = sessions.create({
        orgId: 'org_123',
        apiKeyId: 'key_456',
        clientSchemas: [],
        webhookUrl: 'https://example.com/webhook',
      });

      // Mock global fetch
      const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
      });

      await sessions.close(session.id);

      expect(mockSnapshotStore.save).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      mockFetch.mockRestore();
    });

    test('does not throw if webhook fails, but logs error', async () => {
      const session = sessions.create({
        orgId: 'org_123',
        apiKeyId: 'key_456',
        clientSchemas: [],
        webhookUrl: 'https://example.com/webhook',
      });

      const mockFetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(sessions.close(session.id)).resolves.not.toThrow();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Webhook failed for ${session.id}:`),
        expect.stringContaining('Webhook delivery failed: Network error')
      );

      mockFetch.mockRestore();
      consoleSpy.mockRestore();
    });

    test('does not trigger webhook if webhookUrl is not provided', async () => {
      const session = sessions.create({
        orgId: 'org_123',
        apiKeyId: 'key_456',
        clientSchemas: [],
      });

      const mockFetch = jest.spyOn(global, 'fetch');

      await sessions.close(session.id);

      expect(mockFetch).not.toHaveBeenCalled();

      mockFetch.mockRestore();
    });
  });
});
