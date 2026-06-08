'use strict';

const fs = require('fs');
const path = require('path');

/**
 * ModelRegistry — централизованный реестр моделей с поддержкой горячей перезагрузки.
 * Загружает конфигурацию из config/models-registry.json и кэширует её в памяти.
 */
class ModelRegistry {
  constructor(configPath) {
    this.configPath = configPath || path.join(__dirname, '../../../../config/models-registry.json');
    this.cache = new Map();
    this.lastLoaded = 0;
    this.load();
  }

  /**
   * Загружает или перезагружает реестр моделей из JSON-файла.
   */
  load() {
    try {
      if (!fs.existsSync(this.configPath)) {
        console.warn(`[ModelRegistry] Файл конфигурации не найден: ${this.configPath}. Использую пустой реестр.`);
        this.cache.clear();
        this.lastLoaded = Date.now();
        return;
      }

      const rawData = fs.readFileSync(this.configPath, 'utf8');
      const data = JSON.parse(rawData);
      
      this.cache.clear();
      for (const model of data.models || []) {
        this.cache.set(model.id, {
          name: model.name,
          provider: model.provider,
          contextLength: model.contextLength,
          pricingInputUsdPer1M: model.pricingInputUsdPer1M,
          pricingOutputUsdPer1M: model.pricingOutputUsdPer1M,
          multiplier: parseFloat(model.multiplier) || 1.0,
          allowedTiers: Array.isArray(model.allowedTiers) ? model.allowedTiers : ['pro'],
          status: model.status || 'active'
        });
      }
      
      this.lastLoaded = Date.now();
      console.log(`[ModelRegistry] Успешно загружено ${this.cache.size} моделей.`);
    } catch (err) {
      console.error(`[ModelRegistry] Ошибка загрузки конфигурации: ${err.message}`);
    }
  }

  /**
   * Возвращает конфигурацию модели по её ID.
   * @param {string} modelId 
   * @returns {Object|null}
   */
  getModelConfig(modelId) {
    if (this.cache.size === 0) {
      this.load(); // Lazy reload если кэш пуст
    }
    return this.cache.get(modelId) || null;
  }

  /**
   * Проверяет, разрешена ли модель для указанного тира и активна ли она.
   * @param {string} modelId 
   * @param {string} userTier 
   * @returns {boolean}
   */
  isModelAllowedForTier(modelId, userTier) {
    const config = this.getModelConfig(modelId);
    if (!config || config.status !== 'active') {
      return false;
    }
    return config.allowedTiers.includes(userTier);
  }

  /**
   * Возвращает весовой множитель для модели.
   * @param {string} modelId 
   * @returns {number}
   */
  getMultiplier(modelId) {
    const config = this.getModelConfig(modelId);
    return config ? config.multiplier : 1.0; // Fallback safe value
  }

  /**
   * Возвращает список всех активных моделей для API.
   * @returns {Array}
   */
  getActiveModels() {
    const models = [];
    for (const [id, config] of this.cache.entries()) {
      if (config.status === 'active') {
        models.push({ id, ...config });
      }
    }
    return models;
  }
}

// Singleton instance для использования во всем приложении
const registryPath = path.join(__dirname, '../../../../config/models-registry.json');
const modelRegistry = new ModelRegistry(registryPath);

module.exports = { ModelRegistry, modelRegistry };
