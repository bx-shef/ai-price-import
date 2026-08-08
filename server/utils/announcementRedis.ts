import IORedis from 'ioredis'
import type { RedisOptions } from '../queue/connection'
import type { AnnouncementRedis } from './announcementStore'

// Живой адаптер хранилища объявления (#469). Единственное место, знающее про клиент, — ядро
// (`announcementStore.ts`) остаётся без ioredis и тестируется на памяти.
//
// ⚠ Свой клиент, а не общий со счётчиками: у того `enableOfflineQueue:false` и два повтора —
// правильная настройка для лимитера, который обязан отвечать мгновенно или деградировать. Здесь
// запрос идёт при открытии рабочего экрана и при отправке из консоли, и лишняя миллисекунда
// дешевле, чем «объявления нет» на первом же запросе после выката.

let shared: IORedis | undefined

/** `null` — Redis не настроен: объявлений в такой инсталляции просто нет. */
export function announcementRedis(conn: RedisOptions | null): AnnouncementRedis | null {
  if (!conn) return null
  if (shared === undefined) {
    shared = new IORedis({
      host: conn.host,
      port: conn.port,
      ...(conn.password ? { password: conn.password } : {}),
      ...(conn.username ? { username: conn.username } : {}),
      maxRetriesPerRequest: 2,
      lazyConnect: false
    })
    // Молча: причину недоступности пишет ядро одной строкой, а не клиент на каждое событие.
    shared.on('error', () => {})
  }
  const client: IORedis = shared
  return {
    get: key => client.get(key),
    set: async (key, value, ttlSec) => {
      await client.set(key, value, 'EX', ttlSec)
    },
    del: async (key) => {
      await client.del(key)
    }
  }
}

/** Хранилище на памяти — для тестов и живых прогонов без Redis. */
export function memoryAnnouncementRedis(): AnnouncementRedis {
  const store = new Map<string, string>()
  return {
    get: async key => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value)
    },
    del: async (key) => {
      store.delete(key)
    }
  }
}
