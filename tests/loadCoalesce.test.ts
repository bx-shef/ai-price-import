import { describe, expect, it } from 'vitest'
import { createSingleFlight, reloadDelayMs, SETTINGS_RELOAD_JITTER_MS } from '../app/utils/loadCoalesce'
import { BASE_CURRENCY_TTL_MS, cachedBaseCurrency, forgetBaseCurrency } from '../server/utils/baseCurrencyCache'

/**
 * Веер запросов и гонка при сохранении настроек (#480).
 *
 * ⚠ Оба дефекта ВИДНЫ ТОЛЬКО НА МАСШТАБЕ: на тест-портале с одной открытой вкладкой ни веера, ни
 * гонки не бывает по построению. Поэтому правило вынесено в чистые функции и проверяется здесь —
 * иначе «проверено вживую» означало бы «проверено там, где дефект не воспроизводится».
 */

/**
 * Обещание, которое разрешают снаружи — так проверяется поведение ВО ВРЕМЯ полёта.
 *
 * Разрешается единицей, а не `void`: `Promise<void>` в параметре типа запрещён правилом линтера, а
 * значение здесь всё равно никого не интересует — важен сам момент разрешения.
 */
function deferred() {
  let resolve!: (v: 1) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<1>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('#480: одновременные загрузки склеиваются', () => {
  it('десять вызовов во время полёта дают ДВА запроса, а не десять', async () => {
    // Ровно случай портала с десятком открытых вкладок: событие приходит всем разом.
    const d = deferred()
    let calls = 0
    const task = () => {
      calls++
      return calls === 1 ? d.promise.then(() => {}) : Promise.resolve()
    }
    const flight = createSingleFlight()
    const first = flight.run(task)
    for (let i = 0; i < 9; i++) void flight.run(task)
    expect(calls, 'запрос ушёл больше одного раза, пока первый в полёте').toBe(1)
    d.resolve(1)
    await first
    expect(calls, 'хвостовой повтор обязан быть РОВНО один').toBe(2)
  })

  it('ХВОСТОВОЙ повтор обязателен — присоединиться к старому полёту недостаточно', async () => {
    // ⚠ Несущее. Запрос, начатый ДО сохранения, вернёт настройки ДО сохранения. Голая склейка отдала
    // бы пришедшему ПОСЛЕ этот устаревший ответ и на этом успокоилась — то есть починила бы расход
    // ценой правильности, ровно там, ради чего механизм и заведён.
    const d = deferred()
    const seen: string[] = []
    let version = 'старая'
    const task = () => {
      const v = version
      return (seen.length === 0 ? d.promise : Promise.resolve()).then(() => {
        seen.push(v)
      })
    }
    const flight = createSingleFlight()
    const first = flight.run(task)
    version = 'новая' // сохранение случилось, пока первый запрос в воздухе
    void flight.run(task)
    d.resolve(1)
    await first
    expect(seen.at(-1), 'последним применилось устаревшее состояние').toBe('новая')
  })

  it('без наложения повтора НЕ делается', async () => {
    let calls = 0
    const flight = createSingleFlight()
    await flight.run(async () => {
      calls++
    })
    expect(calls).toBe(1)
    await flight.run(async () => {
      calls++
    })
    expect(calls, 'лишний запрос на ровном месте').toBe(2)
  })

  it('после ОТКАЗА следующий вызов идёт в сеть заново', async () => {
    // Иначе один сетевой сбой запирал бы экран на отказе навсегда: полёт остался бы «в воздухе».
    const flight = createSingleFlight()
    let calls = 0
    await expect(flight.run(async () => {
      calls++
      throw new Error('сеть')
    })).rejects.toThrow()
    expect(flight.inFlight(), 'полёт завис после отказа').toBe(false)
    await flight.run(async () => {
      calls++
    })
    expect(calls).toBe(2)
  })
})

describe('#480: разброс перед перечитыванием', () => {
  it('задержка лежит внутри окна и не отрицательна', () => {
    expect(reloadDelayMs(() => 0)).toBe(0)
    expect(reloadDelayMs(() => 0.999)).toBeLessThan(SETTINGS_RELOAD_JITTER_MS)
    expect(reloadDelayMs(() => 0.5)).toBeGreaterThan(0)
  })

  it('негодный источник случайности не даёт отрицательной или бесконечной задержки', () => {
    // Задержка уходит в setTimeout: отрицательная сработает мгновенно (то есть разброса не будет),
    // а NaN там ведёт себя как ноль — оба варианта молча возвращают тот самый всплеск.
    for (const bad of [() => -1, () => Number.NaN, () => 5]) {
      const d = reloadDelayMs(bad)
      expect(Number.isFinite(d), 'задержка не число').toBe(true)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(SETTINGS_RELOAD_JITTER_MS)
    }
  })
})

describe('#480: базовая валюта не спрашивается на каждое перечитывание', () => {
  it('второе чтение берётся из памяти', async () => {
    forgetBaseCurrency()
    let reads = 0
    const read = async () => {
      reads++
      return 'BYN'
    }
    const a = await cachedBaseCurrency('p1.bitrix24.by', read)
    const b = await cachedBaseCurrency('p1.bitrix24.by', read)
    expect(reads, 'валюта прочитана дважды').toBe(1)
    expect(b.code).toBe('BYN')
    expect(b.cached).toBe(true)
    expect(a.cached).toBe(false)
  })

  it('порталы не делят запомненное между собой', async () => {
    // Ключ — домен из ПРОВЕРЕННОГО фрейм-токена. Сама валюта не секрет, но кэш, ключуемый чем-то
    // клиентским, — это способ смешать данные тенантов, и заводить такую привычку нельзя.
    forgetBaseCurrency()
    const codes = ['BYN', 'RUB']
    const read = async () => codes.shift() ?? null
    expect((await cachedBaseCurrency('a.bitrix24.by', read)).code).toBe('BYN')
    expect((await cachedBaseCurrency('b.bitrix24.by', read)).code).toBe('RUB')
  })

  it('ОТКАЗ чтения не запоминается', async () => {
    // ⚠ «Валюты нет» и «не смогли прочитать» — разные исходы: первый экран заявляет как факт и шлёт
    // админа заводить валюту. Закэшировав отказ, мы держали бы это ложное утверждение весь срок, и
    // сразу у всех сотрудников.
    forgetBaseCurrency()
    let attempt = 0
    const read = async () => {
      attempt++
      if (attempt === 1) throw new Error('портал не ответил')
      return 'KZT'
    }
    const bad = await cachedBaseCurrency('c.bitrix24.by', read)
    expect(bad.failed).toBe(true)
    expect(bad.code).toBeNull()
    const good = await cachedBaseCurrency('c.bitrix24.by', read)
    expect(good.failed, 'отказ закэширован — экран будет врать весь срок').toBe(false)
    expect(good.code).toBe('KZT')
  })

  it('«валюты нет» запоминается — это законный ответ, а не отказ', async () => {
    forgetBaseCurrency()
    let reads = 0
    const read = async () => {
      reads++
      return null
    }
    await cachedBaseCurrency('d.bitrix24.by', read)
    await cachedBaseCurrency('d.bitrix24.by', read)
    expect(reads).toBe(1)
  })

  it('срок истекает, и портал спрашивают снова', async () => {
    forgetBaseCurrency()
    let now = 1_000_000
    let reads = 0
    const read = async () => {
      reads++
      return 'BYN'
    }
    await cachedBaseCurrency('e.bitrix24.by', read, () => now)
    now += BASE_CURRENCY_TTL_MS + 1
    await cachedBaseCurrency('e.bitrix24.by', read, () => now)
    expect(reads, 'запомненное значение живёт дольше своего срока').toBe(2)
  })
})

describe('#480: проводка', () => {
  it('перечитывание по чужому событию идёт с задержкой', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const page = readFileSync(resolve(new URL('..', import.meta.url).pathname, 'app/pages/app.vue'), 'utf8')
    const at = page.indexOf('subscribeReload(')
    expect(at).toBeGreaterThan(-1)
    const handler = page.slice(at, page.indexOf('loadSettings()', at))
    expect(handler, 'разброс потерян — событие снова бьёт всплеском').toMatch(/reloadDelayMs\(\)/)
  })

  it('загрузка настроек идёт через склейку', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(new URL('..', import.meta.url).pathname, 'app/composables/useSettings.ts'), 'utf8')
    expect(src).toMatch(/flight\.run\(loadOnce\)/)
  })
})
