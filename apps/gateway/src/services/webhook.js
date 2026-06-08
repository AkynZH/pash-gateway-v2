'use strict';

/**
 * Systemic Webhook Dispatcher
 * Triggers organization-level webhooks for critical gateway events.
 */
class SystemWebhookDispatcher {
  constructor() {
    // In a real system, this would fetch org webhook URLs from the DB/Control Plane
    this._orgWebhooks = new Map();
  }

  /**
   * Register an org's webhook URL.
   */
  register(orgId, url) {
    this._orgWebhooks.set(orgId, url);
  }

  /**
   * Fire-and-forget systemic event dispatch.
   * @param {string} orgId
   * @param {'pash.error' | 'pash.limit.exceeded' | 'pash.provider.failover'} event
   * @param {Object} payload
   */
  async dispatch(orgId, event, payload) {
    const url = this._orgWebhooks.get(orgId);
    if (!url) {
      return; // No webhook configured for this org
    }

    this._send(url, { event, orgId, ts: Date.now(), ...payload }).catch(err => {
      console.error(`[SystemWebhook] Failed to dispatch ${event} for ${orgId}:`, err.message);
    });
  }

  async _send(url, payload) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (err) {
      throw new Error(`Webhook delivery failed: ${err.message}`);
    }
  }
}

const dispatcher = new SystemWebhookDispatcher();
module.exports = { SystemWebhookDispatcher, dispatcher };
