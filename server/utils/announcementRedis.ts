import IORedis from 'ioredis'
import type { RedisOptions } from '../queue/connection'
import type { AnnouncementRedis } from './announcementStore'

// Живой адаптер хранилища объявления (#469). Единственное место, знающее про клиент, — ядро
// (`announcementStore.ts`) остаётся без ioredis и тестируется на памяти.
//
// ⚠ Свой клиент, а не общий со счётчиками: у объявления другой жизненный цикл (одно значение с
// длинным сроком против множества короткоживущих ключей), и делить лимитерное подключение с ним
// значит связать две несвязанные вещи. Настройки при этом ТЕ ЖЕ, что у соседей, — расхождение
// здесь было бы случайным, а не осмысленным.

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
      // ⚠ Как у счётчиков и стора заданий: на мёртвом Redis команда обязана ОТКАЗАТЬ сразу, а не
      // ждать в очереди клиента. Роут зовут при каждом открытии рабочего экрана, и «объявления
      // нет» через миллисекунду лучше, чем задержка ответа на неработающем хранилище.
      enableOfflineQueue: false,
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
