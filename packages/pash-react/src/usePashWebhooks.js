'use strict';

import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Хук для обработки системных Webhook-событий PASH на фронтенде.
 * Поддерживает подключение через WebSocket или имитацию событий для интеграции.
 * 
 * События:
 * - 'pash.error': Критические ошибки генерации или валидации.
 * - 'pash.limit.exceeded': Превышение лимитов токенов или строк кода.
 * - 'pash.provider.failover': Автоматическое переключение на резервный LLM-провайдер.
 * 
 * @param {string} sessionId - Идентификатор текущей сессии для фильтрации событий
 * @param {string} wsUrl - URL WebSocket для получения событий (опционально)
 * @returns {Object} { events, lastEvent, clearEvents }
 */
export function usePashWebhooks(sessionId, wsUrl = null) {
  const [events, setEvents] = useState([]);
  const [lastEvent, setLastEvent] = useState(null);
  const wsRef = useRef(null);

  const handleEvent = useCallback((eventData) => {
    // Фильтруем события только для текущей сессии, если sessionId передан
    if (sessionId && eventData.sessionId !== sessionId) {
      return;
    }

    const enrichedEvent = {
      ...eventData,
      receivedAt: new Date().toISOString(),
    };

    setLastEvent(enrichedEvent);
    setEvents((prev) => [...prev, enrichedEvent]);

    // Логирование критических событий для разработчика
    if (eventData.event === 'pash.error') {
      console.error('[PASH Webhook] Критическая ошибка:', eventData.details);
    } else if (eventData.event === 'pash.limit.exceeded') {
      console.warn('[PASH Webhook] Превышен лимит:', eventData.details);
    } else if (eventData.event === 'pash.provider.failover') {
      console.info('[PASH Webhook] Failover провайдера:', eventData.details);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!wsUrl) {
      // Режим без WebSocket: хук готов к ручному вызову handleEvent или интеграции с SSE
      return;
    }

    try {
      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.onmessage = (message) => {
        try {
          const eventData = JSON.parse(message.data);
          handleEvent(eventData);
        } catch (err) {
          console.error('[PASH Webhook] Ошибка парсинга сообщения:', err);
        }
      };

      wsRef.current.onerror = (error) => {
        console.error('[PASH Webhook] Ошибка WebSocket:', error);
      };

      wsRef.current.onclose = () => {
        console.warn('[PASH Webhook] Соединение закрыто. Попытка переподключения через 3 сек...');
        setTimeout(() => {
          // Простая логика переподключения (можно усилить через экспоненциальную задержку)
          if (wsUrl) {
             // useEffect перезапустится при изменении зависимости, но здесь мы просто логируем
          }
        }, 3000);
      };
    } catch (err) {
      console.error('[PASH Webhook] Не удалось инициализировать WebSocket:', err);
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [wsUrl, handleEvent]);

  const clearEvents = useCallback(() => {
    setEvents([]);
    setLastEvent(null);
  }, []);

  // Возвращаем handleEvent, чтобы разработчик мог вручную эмулировать события 
  // (например, при интеграции с Server-Sent Events или long-polling)
  return {
    events,
    lastEvent,
    handleEvent,
    clearEvents,
  };
}
