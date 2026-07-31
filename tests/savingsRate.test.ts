import { beforeEach, describe, expect, it, vi } from 'vitest'
import { evictSavingsRate, resolveSavingsRate, SAVINGS_RATE_MISS_TTL_MS, SAVINGS_RATE_TTL_MS } from '../server/utils/savingsRate'

// The glue between «what the portal charges per hour» and «what currency it counts in» (#270).
// Tested here because both halves are cheap to get wrong in ways the pure functions can't see:
// paying for REST calls nobody needs, and turning a cosmetic tile into a 500 on the counters.

function source(rate: number | null, currency: string | null = 'RUB') {
  return {
    readRate: vi.fn(async () => rate),
    readCurrency: vi.fn(async () => currency)
  }
}

beforeEach(() => evictSavingsRate())

describe('resolveSavingsRate', () => {
  it('nothing saved yet → no portal calls at all', async () => {
    const s = source(30)
    expect(await resolveSavingsRate('A', 0, s)).toEqual({})
    expect(s.readRate).not.toHaveBeenCalled()
    expect(s.readCurrency).not.toHaveBeenCalled()
  })

  it('no configured rate → reads settings but NOT the currency', async () => {
    const s = source(null)
    expect(await resolveSavingsRate('A', 10, s)).toEqual({})
    expect(s.readRate).toHaveBeenCalledTimes(1)
    expect(s.readCurrency).not.toHaveBeenCalled()
  })

  it('configured rate → rate + the portal currency', async () => {
    expect(await resolveSavingsRate('A', 10, source(30, 'KZT'))).toEqual({ ratePerHour: 30, currency: 'KZT' })
  })

  it('a failing read degrades to «time only», it does not throw', async () => {
    const s = {
      readRate: vi.fn(async () => { throw new Error('portal down') }),
      readCurrency: vi.fn(async () => 'RUB')
    }
    await expect(resolveSavingsRate('A', 10, s)).resolves.toEqual({})
  })
})

describe('resolveSavingsRate — memo', () => {
  it('second call inside the TTL does not touch the portal again', async () => {
    const s = source(30)
    await resolveSavingsRate('A', 10, s, 1000)
    await resolveSavingsRate('A', 10, s, 1000 + SAVINGS_RATE_TTL_MS - 1)
    expect(s.readRate).toHaveBeenCalledTimes(1)
  })

  it('past the TTL it re-reads', async () => {
    const s = source(30)
    await resolveSavingsRate('A', 10, s, 1000)
    await resolveSavingsRate('A', 10, s, 1000 + SAVINGS_RATE_TTL_MS)
    expect(s.readRate).toHaveBeenCalledTimes(2)
  })

  it('the memo is per portal — B never gets A’s rate', async () => {
    await resolveSavingsRate('A', 10, source(30, 'RUB'), 1000)
    expect(await resolveSavingsRate('B', 10, source(50, 'KZT'), 1000))
      .toEqual({ ratePerHour: 50, currency: 'KZT' })
  })

  it('a failed read is cached too — a broken portal is not re-tried every open', async () => {
    const s = {
      readRate: vi.fn(async () => { throw new Error('portal down') }),
      readCurrency: vi.fn(async () => 'RUB')
    }
    await resolveSavingsRate('A', 10, s, 1000)
    await resolveSavingsRate('A', 10, s, 1000)
    expect(s.readRate).toHaveBeenCalledTimes(1)
  })

  it('evict drops one portal, keeping the rest', async () => {
    const a = source(30)
    await resolveSavingsRate('A', 10, a, 1000)
    await resolveSavingsRate('B', 10, source(50), 1000)
    evictSavingsRate('A')
    await resolveSavingsRate('A', 10, a, 1000)
    expect(a.readRate).toHaveBeenCalledTimes(2)
  })
})

describe('resolveSavingsRate — TTL неполного ответа', () => {
  it('неполный ответ (ставка есть, валюты нет) живёт минуту, а не десять', async () => {
    const s = source(30, null)
    await resolveSavingsRate('A', 10, s, 1000)
    // Внутри короткого окна — из кэша.
    await resolveSavingsRate('A', 10, s, 1000 + SAVINGS_RATE_MISS_TTL_MS - 1)
    expect(s.readCurrency).toHaveBeenCalledTimes(1)
    // Сразу после — перечитываем: админ мог завести валюту в CRM, к нам запрос при этом не приходит.
    await resolveSavingsRate('A', 10, s, 1000 + SAVINGS_RATE_MISS_TTL_MS)
    expect(s.readCurrency).toHaveBeenCalledTimes(2)
  })
  it('полный ответ держится все десять минут', async () => {
    const s = source(30, 'BYN')
    await resolveSavingsRate('A', 10, s, 1000)
    await resolveSavingsRate('A', 10, s, 1000 + SAVINGS_RATE_MISS_TTL_MS + 1)
    expect(s.readRate).toHaveBeenCalledTimes(1)
    await resolveSavingsRate('A', 10, s, 1000 + SAVINGS_RATE_TTL_MS)
    expect(s.readRate).toHaveBeenCalledTimes(2)
  })
})

describe('сбой чтения валюты не выглядит как «ставка не задана»', () => {
  it('ставка прочиталась, валюта упала → ставка сохраняется, валюта пустая', async () => {
    const s = {
      readRate: vi.fn(async () => 30),
      readCurrency: vi.fn(async () => { throw new Error('портал недоступен') })
    }
    // Раньше общий try обнулял ВЕСЬ ответ, и главная советовала «укажите стоимость часа» тому,
    // кто её уже указал.
    expect(await resolveSavingsRate('A', 10, s, 1000)).toEqual({ ratePerHour: 30, currency: null })
  })

  it('«ставка не задана» держится долго — это исправляется через нас, кэш сбрасывается на сохранении', async () => {
    const s = source(null)
    await resolveSavingsRate('A', 10, s, 1000)
    await resolveSavingsRate('A', 10, s, 1000 + SAVINGS_RATE_MISS_TTL_MS + 1)
    expect(s.readRate).toHaveBeenCalledTimes(1) // короткий TTL тут дал бы 10× вызовов навсегда
    await resolveSavingsRate('A', 10, s, 1000 + SAVINGS_RATE_TTL_MS)
    expect(s.readRate).toHaveBeenCalledTimes(2)
  })
})
