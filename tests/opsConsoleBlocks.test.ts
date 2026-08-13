import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Блоки служебной консоли сообщают о просроченной сессии наверх, а не прячут её в свою ошибку (#523).
 *
 * ЗАЧЕМ. Разбирая `pages/queues.vue` на блоки (`QueueMonitor`, `OpsPortalsCard`, `OpsRatingsCard`),
 * мы раздали каждому свой запрос и свою ошибку. Это правильно (#271-E: молчащий блок оператор читал
 * как «данных нет»), но у 401 смысл другой — это не отказ блока, а конец сессии, и лечится он
 * уходом на вход, а не текстом в карточке.
 *
 * Дефект этого класса уже случался ДО разбора и записан в самом коде: «любой статус схлопывался в
 * „не удалось“, и вкладка продолжала долбить эндпоинт каждые 12 секунд с неверной причиной». После
 * разбора его стало легче воспроизвести: блоков три, обработчик у каждого свой, и забыть про 401 в
 * четвёртом достаточно один раз.
 *
 * ⚠ Проверка структурная (по тексту SFC): смонтировать консоль без сессии оператора нельзя, а
 * мутации, которые она ловит, — ровно те, что случаются: новый блок без `unauthorized`, страница,
 * не подписанная на событие, и уход на вход БЕЗ остановки автообновления.
 */

const ROOT = new URL('..', import.meta.url).pathname
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')
/** Комментарии режем: гард, краснеющий на разборе дефекта, подталкивает удалить разбор, а не дефект. */
const strip = (sfc: string) => sfc.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

/** Блоки консоли, которые ходят в сеть сами. `OpsAnnouncementCard` в список не входит: он не
 *  участвует в автообновлении и о состоянии сессии узнаёт из своей отправки. */
const BLOCKS = [
  'app/components/QueueMonitor.vue',
  'app/components/OpsPortalsCard.vue',
  'app/components/OpsRatingsCard.vue'
] as const

describe('#523: служебная консоль разобрана на блоки', () => {
  for (const block of BLOCKS) {
    it(`${block}: объявляет событие о просроченной сессии`, () => {
      expect(strip(read(block)), 'блок не умеет сообщить, что сессия истекла').toMatch(/defineEmits<\{[\s\S]*?unauthorized/)
    })

    it(`${block}: каждый разбор 401 заканчивается этим событием, а не своей ошибкой`, () => {
      const src = strip(read(block))
      // Сколько раз блок узнаёт просроченную сессию — столько раз он обязан сказать об этом наверх.
      const detects = (src.match(/isExpired\(e\)/g) || []).length
      const emits = (src.match(/emit\('unauthorized'\)/g) || []).length
      expect(detects, 'блок нигде не отличает просроченную сессию от отказа сервиса').toBeGreaterThan(0)
      expect(emits, `${detects} мест распознают 401, а наверх сообщают ${emits}`).toBe(detects)
    })

    it(`${block}: сравнение с 401 живёт ровно в одном месте — в самом isExpired`, () => {
      // Без этого счёт выше обходится в одну строку: написал `statusCode === 401` руками, показал
      // свою ошибку — и просроченная сессия снова читается как отказ сервиса.
      const raw = (strip(read(block)).match(/===\s*401/g) || []).length
      expect(raw, 'сравнение с 401 появилось мимо isExpired').toBe(1)
    })

    it(`${block}: отдаёт странице reload() — иначе выпадет из автообновления`, () => {
      expect(strip(read(block))).toMatch(/defineExpose\(\{\s*reload/)
    })
  }

  it('страница подписана на событие у КАЖДОГО блока', () => {
    const page = strip(read('app/pages/queues.vue'))
    const handled = (page.match(/@unauthorized="onUnauthorized"/g) || []).length
    expect(handled, 'блок остался без обработчика — просроченная сессия молча превратится в ошибку').toBe(BLOCKS.length)
  })

  it('уход на вход гасит автообновление и защищён от повторов', () => {
    // Блоки грузятся ПАРАЛЛЕЛЬНО, поэтому о просроченной сессии сообщат все три разом. Без замка это
    // три навигации подряд, а без `stopAuto()` вкладка успевает послать ещё круг запросов заведомо
    // просроченной сессией — ровно то, чем был плох прежний «схлопнутый» разбор 401.
    const page = strip(read('app/pages/queues.vue'))
    const handler = page.slice(page.indexOf('async function onUnauthorized'))
    const body = handler.slice(0, handler.indexOf('\n}') + 2)
    expect(body, 'нет замка от повторного ухода').toMatch(/leaving/)
    expect(body, 'автообновление не остановлено перед уходом').toMatch(/stopAuto\(\)/)
    expect(body).toMatch(/router\.push\('\/login'\)/)
  })

  it('страница больше не держит запросы блоков у себя', () => {
    // Смысл разбора: правка одного блока не читает и не ломает два соседних. Вернувшийся в страницу
    // `$fetch` к эндпоинту блока — это возврат к 895 строкам, только теперь с копией в компоненте.
    const page = strip(read('app/pages/queues.vue'))
    for (const url of ['/api/ops/queues', '/api/ops/tokens', '/api/ops/app-rating', '/api/ops/failed']) {
      expect(page, `запрос ${url} вернулся в страницу`).not.toContain(url)
    }
  })
})
