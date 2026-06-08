'use strict';

/**
 * SecurityPipeline проверяет данные на наличие XSS-векторов и утечек чувствительной информации (PII, API Keys).
 */
class SecurityPipeline {
  constructor(options = {}) {
    this.rules = {
      xss: [
        /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
        /javascript\s*:/gi,
        /on(?:error|load|click|mouse\w+)\s*=/gi,
        /<iframe\b[^>]*>/gi,
        /<object\b[^>]*>/gi,
        /<embed\b[^>]*>/gi,
      ],
      secrets: [
        /(?:sk|pk)_[a-zA-Z0-9_]{20,}/i, // Stripe-like API keys (allows underscores)
        /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}/i, // GitHub tokens
        /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/, // Basic Credit Card pattern
      ],
      ...options.customRules,
    };
    this.redactChar = options.redactChar || '***REDACTED***';
    this.strictMode = options.strictMode !== false; // По умолчанию строгий режим (выбрасывает ошибку)
  }

  /**
   * Проверяет строку или массив строк/объектов на соответствие правилам безопасности.
   * @param {any} data - Данные для проверки (строка, объект или массив).
   * @returns {any} - Очищенные данные (если strictMode=false) или выбрасывает ошибку.
   */
  inspect(data) {
    if (typeof data === 'string') {
      return this._checkString(data);
    } else if (Array.isArray(data)) {
      return data.map(item => this.inspect(item));
    } else if (data !== null && typeof data === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(data)) {
        result[key] = this.inspect(value);
      }
      return result;
    }
    return data;
  }

  _checkString(str) {
    // 1. Проверка на XSS
    for (const regex of this.rules.xss) {
      if (regex.test(str)) {
        if (this.strictMode) {
          throw new Error(`SECURITY_VIOLATION: XSS vector detected in string: "${str.substring(0, 50)}..."`);
        } else {
          // В нестрогом режиме можно было бы санитизировать, но для PASH лучше блокировать
          return str.replace(regex, '[BLOCKED]');
        }
      }
    }

    // 2. Проверка на секреты
    for (const regex of this.rules.secrets) {
      if (regex.test(str)) {
        if (this.strictMode) {
          throw new Error(`SECURITY_VIOLATION: Sensitive data pattern detected in string: "${str.substring(0, 50)}..."`);
        } else {
          return str.replace(regex, this.redactChar);
        }
      }
    }

    return str;
  }

  /**
   * Санитизация HTML (экранирование). Используется как fallback, если strictMode отключен.
   */
  sanitize(str) {
    if (typeof str !== 'string') return str;
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }
}

module.exports = { SecurityPipeline };
