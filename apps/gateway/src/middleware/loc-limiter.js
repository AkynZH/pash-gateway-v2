'use strict';

/**
 * Middleware для управления лимитами Lines of Code (LoC) и Rate Limiting.
 * Реализует формулу: Списано строк = ceil(кол-во символов / 256) * multiplier_модели.
 * Готов к миграции на Cloudflare Durable Objects (сейчас использует in-memory Map для демонстрации).
 */

// Временное in-memory хранилище (в CF Workers заменить на Durable Objects / KV)
const userUsageStore = new Map();
const rateLimitStore = new Map();

const MODEL_MULTIPLIERS = {
  'minimax-m2.5:free': 1.0,
  'owl-alpha:free': 1.0,
  'gpt-4o-mini': 2.5,
  'claude-3-haiku': 2.5,
  'gpt-4o': 10.0,
  'claude-3.5-sonnet': 10.0,
  'default': 1.0,
};

const TIER_LIMITS = {
  community: { locLimit: 50000, rpm: 10, rph: 100 },
  startup: { locLimit: 250000, rpm: 30, rph: 500 },
  pro: { locLimit: Infinity, rpm: 100, rph: 2000 },
};

/**
 * Рассчитывает вес строки на основе длины символа и множителя модели.
 * 1 PASH LoC = максимум 256 символов.
 */
function calculateWeightedLoc(charCount, modelName) {
  const multiplier = MODEL_MULTIPLIERS[modelName] || MODEL_MULTIPLIERS.default;
  const baseLoc = Math.ceil(charCount / 256);
  return Math.ceil(baseLoc * multiplier);
}

/**
 * Проверяет и обновляет Rate Limit (Token Bucket упрощенный).
 */
function checkRateLimit(userId, tier, clientType) {
  const now = Date.now();
  const limits = TIER_LIMITS[tier] || TIER_LIMITS.community;
  
  // Для CI/CD даем чуть более высокие лимиты, но строже контролируем контекст
  const rpmLimit = clientType === 'cicd' ? Math.floor(limits.rpm * 1.5) : limits.rpm;
  const rphLimit = clientType === 'cicd' ? Math.floor(limits.rph * 1.5) : limits.rph;

  if (!rateLimitStore.has(userId)) {
    rateLimitStore.set(userId, { minuteTokens: rpmLimit, hourTokens: rphLimit, lastMinuteReset: now, lastHourReset: now });
  }

  const bucket = rateLimitStore.get(userId);

  // Сброс минутного бакета
  if (now - bucket.lastMinuteReset >= 60000) {
    bucket.minuteTokens = rpmLimit;
    bucket.lastMinuteReset = now;
  }
  // Сброс часового бакета
  if (now - bucket.lastHourReset >= 3600000) {
    bucket.hourTokens = rphLimit;
    bucket.lastHourReset = now;
  }

  if (bucket.minuteTokens <= 0 || bucket.hourTokens <= 0) {
    return {
      allowed: false,
      retryAfter: bucket.minuteTokens <= 0 ? 60 : 3600,
      locRemaining: getLocRemaining(userId, tier),
      locLimit: limits.locLimit,
    };
  }

  bucket.minuteTokens -= 1;
  bucket.hourTokens -= 1;

  return {
    allowed: true,
    locRemaining: getLocRemaining(userId, tier),
    locLimit: limits.locLimit,
  };
}

function getLocRemaining(userId, tier) {
  const limits = TIER_LIMITS[tier] || TIER_LIMITS.community;
  const used = userUsageStore.get(userId) || 0;
  return Math.max(0, limits.locLimit - used);
}

/**
 * Fastify preHandler hook для проверки лимитов ПЕРЕД запросом.
 */
async function preRequestLocLimit(request, reply) {
  const user = request.pashContext || { orgId: 'anonymous', tier: 'community' };
  const userId = user.orgId;
  const tier = user.tier || 'community';
  const clientType = request.headers['x-pash-client-type'] || 'browser';
  const modelName = request.body?.model || 'default';

  const rateCheck = checkRateLimit(userId, tier, clientType);

  // Добавляем базовые заголовки
  reply.header('x-pash-tier', tier);
  reply.header('x-pash-client-type', clientType);
  reply.header('x-pash-loc-limit', String(rateCheck.locLimit));
  reply.header('x-pash-loc-remaining', String(rateCheck.locRemaining));

  if (rateCheck.locRemaining === 0) {
    reply.header('x-pash-warning', 'limit_exceeded');
    return reply.code(429).send({
      error: 'community_limit_exceeded',
      message: 'You hit your LoC limit. Upgrade to Startup Tier.',
      upgrade_url: '/billing/upgrade',
    });
  }

  if (rateCheck.locRemaining < (rateCheck.locLimit * 0.1)) {
    reply.header('x-pash-warning', 'approaching_limit');
  }

  if (!rateCheck.allowed) {
    reply.header('Retry-After', String(rateCheck.retryAfter));
    return reply.code(429).send({
      error: 'rate_limit_triggered',
      message: `Rate limit exceeded. Retry after ${rateCheck.retryAfter} seconds.`,
      retry_after: rateCheck.retryAfter,
    });
  }

  // Сохраняем состояние для использования в стриме
  request.pashLocContext = {
    userId,
    tier,
    modelName,
    locRemaining: rateCheck.locRemaining,
    locLimit: rateCheck.locLimit,
  };
}

/**
 * Создает TransformStream для перехвата чанков и подсчета LoC в реальном времени.
 * Если лимит исчерпан, стрим принудительно завершается маркером ошибки.
 */
function createLocTrackingStream(req) {
  const { userId, modelName, locLimit } = req.pashLocContext;
  let currentLocUsed = 0;
  let charBuffer = '';

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      const text = chunk.toString();
      charBuffer += text;

      // Подсчитываем строки по мере появления \n или накопления буфера
      const lines = charBuffer.split('\n');
      charBuffer = lines.pop() || ''; // Оставляем неполную строку в буфере

      let newlyGeneratedChars = 0;
      for (const line of lines) {
        newlyGeneratedChars += line.length + 1; // +1 для \n
      }

      if (newlyGeneratedChars > 0) {
        const weightedLoc = calculateWeightedLoc(newlyGeneratedChars, modelName);
        currentLocUsed += weightedLoc;
        
        // Обновляем глобальный счетчик (в CF это будет атомарный инкремент в DO)
        const currentTotal = userUsageStore.get(userId) || 0;
        userUsageStore.set(userId, currentTotal + weightedLoc);

        const remaining = Math.max(0, locLimit - (currentTotal + weightedLoc));
        
        // Мы не можем легко менять заголовки во время стрима в Express, 
        // но мы можем прервать стрим, если лимит исчерпан.
        if (remaining <= 0) {
          controller.enqueue(
            Buffer.from(`\n\n!error|reason=community_limit_exceeded|msg=You hit your LoC limit. Upgrade to Startup Tier.`)
          );
          controller.terminate();
          return;
        }
      }

      controller.enqueue(chunk);
    },
    flush(controller) {
      // Обрабатываем оставшийся буфер
      if (charBuffer.length > 0) {
        const weightedLoc = calculateWeightedLoc(charBuffer.length, modelName);
        const currentTotal = userUsageStore.get(userId) || 0;
        userUsageStore.set(userId, currentTotal + weightedLoc);
      }
      controller.terminate();
    }
  });

  return transformStream;
}

module.exports = {
  preRequestLocLimit,
  createLocTrackingStream,
  calculateWeightedLoc,
  // Экспортируем для тестов
  __resetStore: () => {
    userUsageStore.clear();
    rateLimitStore.clear();
  },
  TIER_LIMITS,
  MODEL_MULTIPLIERS,
};
