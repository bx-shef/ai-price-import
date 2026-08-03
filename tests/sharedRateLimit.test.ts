import { describe, expect, it } from 'vitest'
import { bucketTtlSec, createSharedLimiter, memoryWindowStore, windowKey, windowResetMs, type WindowCounterStore } from '../server/utils/sharedRateLimit'
import { PORTAL_ATTACH_LIMIT, REPO_ATTACH_LIMIT, createAttachBudget } from '../server/utils/feedbackRepoBudget'

// #353 + #354. Оба пер-сотрудничьих лимитера считали в памяти СВОЕГО процесса. Пока HTTP-роль —
// один экземпляр, это настоящий предел; стоит размножить её ради отказоустойчивости, и каждая
// реплика заводит свой счёт, а фактический предел становится N×. Ни ошибки, ни строки в журнале —
// защита просто тихо слабеет во столько раз, сколько реплик, причём у отзывов слабеет ровно там,
// где стоит деньгами (квота GitHub издателя). Глобальный предел на приёмник в памяти не мог жить
// вовсе: это предел на ПОЛУЧАТЕЛЯ, а отправителей по определению может быть несколько.

/** Общий стор — та самая роль, которую в проде играет Redis: счёт ОДИН на всех. */
function memoryStore(): WindowCounterStore & { keys: () => string[] } {
  const n = new Map<string, number>()
  return {
    async incrWithTtl(key) {
      const v = (n.get(key) ?? 0) + 1
      n.set(key, v)
      return v
    },
    keys: () => [...n.keys()]
  }
}

const SPEC = { prefix: 'test', limit: 3, windowMs: 1000 }

describe('#353: счётчик действительно общий', () => {
  it('два экземпляра лимитера на одном сторе ДЕЛЯТ лимит', () => {
    // Это и есть проверка, ради которой всё затевалось: два «экземпляра» — модель двух реплик
    // HTTP-роли. На памяти процесса каждый пропустил бы по три, то есть шесть вместо трёх.
    const store = memoryStore()
    const a = createSharedLimiter(SPEC, store)
    const b = createSharedLimiter(SPEC, store)
    return (async () => {
      expect((await a.check('u', 0)).allowed).toBe(true)
      expect((await b.check('u', 0)).allowed).toBe(true)
      expect((await a.check('u', 0)).allowed).toBe(true)
      // Четвёртая — уже сверх предела, независимо от того, какой «реплике» она досталась.
      expect((await b.check('u', 0)).allowed).toBe(false)
    })()
  })

  it('ключи разных сотрудников не смешиваются', async () => {
    const store = memoryStore()
    const l = createSharedLimiter(SPEC, store)
    for (let i = 0; i < 3; i++) await l.check('u1', 0)
    expect((await l.check('u1', 0)).allowed).toBe(false)
    expect((await l.check('u2', 0)).allowed).toBe(true)
  })

  it('разные применения не сталкиваются в одном Redis', () => {
    // Загрузки, отзывы и приёмник — три применения одной конструкции; без пространства имён
    // сотрудник, исчерпавший загрузки, оказался бы без отзывов.
    expect(windowKey({ ...SPEC, prefix: 'upload' }, 'u', 0)).not.toBe(windowKey({ ...SPEC, prefix: 'feedback' }, 'u', 0))
  })

  it('новое окно — новый ключ, ничего не надо сбрасывать', async () => {
    const store = memoryStore()
    const l = createSharedLimiter(SPEC, store)
    for (let i = 0; i < 3; i++) await l.check('u', 0)
    expect((await l.check('u', 999)).allowed).toBe(false)
    expect((await l.check('u', 1000)).allowed).toBe(true)
  })

  it('до конца окна — столько, сколько осталось, а не полное окно', async () => {
    const store = memoryStore()
    const l = createSharedLimiter(SPEC, store)
    for (let i = 0; i < 4; i++) await l.check('u', 700)
    expect((await l.check('u', 700)).retryAfterMs).toBe(300)
    expect(windowResetMs(SPEC, 700)).toBe(300)
  })

  it('ключ живёт дольше своего окна', () => {
    // Иначе ключ, заведённый в конце окна, умирал бы раньше самого окна.
    expect(bucketTtlSec(SPEC.windowMs)).toBeGreaterThanOrEqual(SPEC.windowMs / 1000)
  })
})

describe('#353: недоступный стор не отказывает в обслуживании', () => {
  it('без стора считаем в памяти и говорим об этом ОДИН раз', async () => {
    const said: string[] = []
    const l = createSharedLimiter(SPEC, null, r => said.push(r))
    const d = await l.check('u', 0)
    expect(d.allowed).toBe(true)
    expect(d.degraded, 'вызывающий обязан видеть, что счёт не общий').toBe(true)
    await l.check('u', 0)
    await l.check('u', 0)
    // Строка в журнале на КАЖДЫЙ запрос залила бы лог ровно во время аварии.
    expect(said).toHaveLength(1)
  })

  it('упавший стор — не «предел исчерпан», а фолбэк', async () => {
    // Обратное превратило бы сбой хранилища в отказ сервиса.
    const dead: WindowCounterStore = { incrWithTtl: async () => null }
    const l = createSharedLimiter(SPEC, dead)
    const d = await l.check('u', 0)
    expect(d.allowed).toBe(true)
    expect(d.degraded).toBe(true)
  })

  it('фолбэк всё-таки ограничивает — иначе он бесполезен', async () => {
    const dead: WindowCounterStore = { incrWithTtl: async () => null }
    const l = createSharedLimiter(SPEC, dead)
    for (let i = 0; i < 3; i++) expect((await l.check('u', 0)).allowed).toBe(true)
    expect((await l.check('u', 0)).allowed).toBe(false)
  })
})

describe('#354: глобальный предел на репозиторий-приёмник', () => {
  const store = () => {
    const n = new Map<string, number>()
    return {
      incrWithTtl: async (k: string) => {
        const v = (n.get(k) ?? 0) + 1
        n.set(k, v)
        return v
      }
    }
  }

  it('до предела файл едет, после — отзыв всё равно принят, но БЕЗ файла', async () => {
    // Это главное отличие от пер-сотрудничьих лимитов: там превышение = отказ (429), здесь —
    // отзыв принимаем, теряем только вложение. Текст отзыва ценнее файла.
    // Порталов берём столько, чтобы упереться именно в ОБЩИЙ предел, а не в долю портала.
    const check = createAttachBudget(store(), () => {})
    let sent = 0
    for (let p = 0; sent < REPO_ATTACH_LIMIT; p++) {
      for (let i = 0; i < PORTAL_ATTACH_LIMIT && sent < REPO_ATTACH_LIMIT; i++, sent++) {
        expect((await check(`m${p}`, 0)).allowed).toBe(true)
      }
    }
    const over = await check('m-fresh', 0)
    expect(over.allowed).toBe(false)
    expect(over.notice, 'молчание прочиталось бы как «документ ушёл»').toBeTruthy()
  })

  it('один портал не может съесть весь приёмник', async () => {
    // Пер-сотрудничий предел — 12 за 10 минут, то есть 72 в час: БОЛЬШЕ, чем весь бюджет
    // приёмника. Без доли на портал один занятый арендатор оставлял бы без вложений всех
    // остальных, ни разу не превысив собственный лимит.
    expect(PORTAL_ATTACH_LIMIT).toBeLessThan(REPO_ATTACH_LIMIT)
    const check = createAttachBudget(store(), () => {})
    for (let i = 0; i < PORTAL_ATTACH_LIMIT; i++) expect((await check('m1', 0)).allowed).toBe(true)
    expect((await check('m1', 0)).allowed, 'своя доля исчерпана').toBe(false)
    expect((await check('m2', 0)).allowed, 'сосед не должен страдать').toBe(true)
  })

  it('исчерпавший свою долю не тикает общий счёт', async () => {
    // Иначе отказанный арендатор всё равно вычерпывал бы приёмник — просто получая отказы.
    const check = createAttachBudget(store(), () => {})
    for (let i = 0; i < PORTAL_ATTACH_LIMIT * 10; i++) await check('m1', 0)
    // Общий бюджет потрачен ровно на долю портала, остальное свободно.
    let ok = 0
    for (let p = 2; p < 20; p++) for (let i = 0; i < PORTAL_ATTACH_LIMIT; i++) if ((await check(`m${p}`, 0)).allowed) ok++
    expect(ok).toBe(REPO_ATTACH_LIMIT - PORTAL_ATTACH_LIMIT)
  })

  it('без общего счёта вложения ВЫКЛЮЧЕНЫ, а не «считаем в памяти»', async () => {
    // Пер-сотрудничьи лимиты в памяти всё ещё делают свою работу (обрывают цикл одного человека).
    // Здесь — нет: смысл в потолке на ОБЩЕГО получателя, а «потолок на процесс» это не ослабленная
    // версия того же, это другое и неверное — несколько процессов выдали бы по полному бюджету,
    // то есть ровно ту аварию, от которой предел и защищает.
    const check = createAttachBudget(null, () => {})
    const d = await check('m1', 0)
    expect(d.degraded).toBe(true)
    expect(d.allowed).toBe(false)
    expect(d.notice).toBeTruthy()
  })

  it('расход журналируется — предел не должен оказаться сюрпризом', async () => {
    const said: string[] = []
    const check = createAttachBudget(store(), m => said.push(m))
    await check('m1', 0)
    expect(said.join()).toMatch(/1\/60/)
  })
})

describe('#353: предупреждение о фолбэке — раз на эпизод, а не раз на процесс', () => {
  it('вторая авария объявляется снова', async () => {
    // Флаг, который взводится навсегда, делает ВТОРОЙ сбой Redis полностью немым — а «предел не
    // действует» не должно быть невидимым состоянием.
    const said: string[] = []
    let alive = false
    const flaky: WindowCounterStore = { incrWithTtl: async () => (alive ? 1 : null) }
    const l = createSharedLimiter(SPEC, flaky, r => said.push(r))
    await l.check('u', 0) // авария №1 — объявлена
    await l.check('u', 0) // та же авария — молчим
    expect(said).toHaveLength(1)
    alive = true
    await l.check('u', 0) // всё поднялось
    alive = false
    await l.check('u', 0) // авария №2 — обязана быть объявлена
    expect(said).toHaveLength(2)
  })
})

describe('#353 ревью: переполнение памяти фолбэка не обнуляет счёт', () => {
  it('вытесняется часть ключей, а не все сразу', async () => {
    // Прежний `clear()` при переполнении сбрасывал ВСЕ вёдра, то есть прощал счёт всем, кого сейчас
    // ограничивают. Замер на маленьком капе: чередование «жертва + шум» проходило 20 из 20.
    const store = memoryWindowStore(8)
    const l = createSharedLimiter({ prefix: 'evict', limit: 3, windowMs: 1000 }, store)
    let allowed = 0
    for (let i = 0; i < 20; i++) {
      if ((await l.check('victim', 0)).allowed) allowed++
      await l.check(`noise${i}`, 0) // гонит размер карты за кап
    }
    expect(allowed, 'счёт жертвы обнулялся вытеснением').toBeLessThanOrEqual(6)
  })
})
