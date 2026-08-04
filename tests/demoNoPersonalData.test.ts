import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { anonRateKey, anonRateKeyWith, matchesAnonKey } from '../server/utils/anonRateKey'

// #413. В демо-разборе не должно образовываться персональных данных — тогда вопрос о статусе
// издателя как владельца по Закону № 99-З / оператора по 152-ФЗ снимается технически.
//
// Проверяется ДВА разных утверждения, и путать их нельзя:
//   • поведение отпечатка — необратимость и разделение ведёр (обычные тесты ниже);
//   • отсутствие IP на путях демо — структурный гард по исходникам. Второе тестом поведения не
//     доказать: адрес утекает не через возвращаемое значение, а через строку в журнале или запись
//     в стор, которых на happy-path никто не наблюдает.

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

describe('#413: ключ ограничения частоты необратим', () => {
  const KEY = 'test-secret-not-the-process-one'

  it('одинаковый адрес и браузер дают одинаковый ключ — счётчик работает', () => {
    expect(anonRateKeyWith('203.0.113.7', 'Mozilla/5.0', KEY)).toBe(anonRateKeyWith('203.0.113.7', 'Mozilla/5.0', KEY))
  })

  it('разные адреса — разные ведра', () => {
    expect(anonRateKeyWith('203.0.113.7', 'UA', KEY)).not.toBe(anonRateKeyWith('203.0.113.8', 'UA', KEY))
  })

  it('разные браузеры за одним адресом — разные вёдра', () => {
    // Не идентификация устройства, а энтропия: за домашним адресом сидит несколько человек, и без
    // этого один из них выбирал бы лимит на всех.
    expect(anonRateKeyWith('203.0.113.7', 'Firefox', KEY)).not.toBe(anonRateKeyWith('203.0.113.7', 'Safari', KEY))
  })

  it('в ключе нет самого адреса — ни целиком, ни куском', () => {
    const ip = '203.0.113.7'
    const k = anonRateKeyWith(ip, 'Mozilla/5.0', KEY)
    expect(k).not.toContain(ip)
    for (const octet of ip.split('.')) expect(k.includes(octet) && octet.length > 2).toBe(false)
    expect(k).toMatch(/^[0-9a-f]{32}$/)
  })

  it('без секрета ключ не воспроизводится — перебор 4·10⁹ адресов бесполезен', () => {
    // Ровно то, ради чего HMAC, а не голый SHA-256: зная алгоритм и адрес, но не зная секрет,
    // получить тот же отпечаток нельзя.
    const mine = anonRateKeyWith('203.0.113.7', 'UA', KEY)
    expect(anonRateKeyWith('203.0.113.7', 'UA', 'другой-секрет')).not.toBe(mine)
    expect(matchesAnonKey(mine, '203.0.113.7', 'UA', KEY)).toBe(true)
    expect(matchesAnonKey(mine, '203.0.113.7', 'UA', 'другой-секрет')).toBe(false)
  })

  it('секрет процесса не берётся из окружения — его нельзя ни задать, ни прочитать', () => {
    // Секрет в env означал бы, что он живёт в конфигурации деплоя, в истории shell и в бэкапе
    // сервера — то есть отпечаток снова обратим для того, у кого есть доступ к серверу.
    const src = read('../server/utils/anonRateKey.ts')
    expect(src).toMatch(/randomBytes\(32\)/)
    expect(src, 'секрет читается из env').not.toMatch(/process\.env/)
    // И сам ключ не должен возвращаться наружу целиком где-то ещё — проверка живёт ниже, по роуту.
    expect(anonRateKey('203.0.113.7', 'UA')).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('#413: на путях демо не остаётся IP-адреса', () => {
  const route = read('../server/api/demo/extract.post.ts')

  it('лимитер получает отпечаток, а не адрес', () => {
    // Мутация «вернуть rateLimitKey напрямую в limiter.check» — ровно то, что этот гард ловит:
    // она не роняет ни один поведенческий тест, потому что лимитер работает одинаково.
    expect(route).toContain('anonRateKey(')
    const checkAt = route.indexOf('limiter.check(')
    const anonAt = route.indexOf('anonRateKey(')
    expect(anonAt, 'отпечаток не строится').toBeGreaterThan(-1)
    expect(anonAt < checkAt, 'отпечаток строится после проверки лимита').toBe(true)
    // `rateLimitKey` (сырой адрес) должен уходить ТОЛЬКО в anonRateKey — не в переменную, которую
    // потом можно залогировать.
    const rawUses = [...route.matchAll(/rateLimitKey\(/g)].length
    expect(rawUses, 'сырой ключ строится больше одного раза — куда идёт второй?').toBe(1)
  })

  it('ни адрес, ни отпечаток не попадают в журнал и в ответ', () => {
    // Журнал сервера — такое же хранилище, как база: строка с IP в нём это те же персональные
    // данные, только их никто не считает данными.
    const logLines = route.split('\n').filter(l => /console\.(log|info|warn|error)/.test(l))
    for (const line of logLines) {
      expect(line, `в журнал уходит адрес: ${line.trim()}`).not.toMatch(/remoteAddress|x-forwarded-for|\bkey\b/)
    }
    // В ответе 429 — только секунды до разблокировки; ни адреса, ни отпечатка.
    const four29 = route.slice(route.indexOf('429'), route.indexOf('429') + 600)
    expect(four29).not.toMatch(/remoteAddress|\bkey\b/)
  })
})
