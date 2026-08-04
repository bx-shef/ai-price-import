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

describe('#413: адреса нет и в журнале веб-сервера', () => {
  const nginx = read('../nginx.conf')

  it('журнал пишется своим форматом, а не стандартным combined', () => {
    // Журнал — такое же хранилище, как база: строка с адресом в нём это ровно те персональные
    // данные, от которых уходит весь остальной пакет. Мутация «убрать access_log» возвращает
    // стандартный combined с полным $remote_addr и не роняет ничего, кроме этого гарда.
    expect(nginx).toMatch(/log_format\s+anon/)
    expect(nginx).toMatch(/access_log\s+\S+\s+anon;/)
  })

  it('в самом формате нет ни полного адреса, ни заголовка, который его несёт', () => {
    const fmt = nginx.slice(nginx.indexOf('log_format anon'))
    const body = fmt.slice(0, fmt.indexOf(';'))
    expect(body, 'в журнал уходит полный адрес').not.toMatch(/\$remote_addr/)
    // XFF несёт тот же адрес — прокси дописывает реального пира в конец списка.
    expect(body, 'в журнал уходит X-Forwarded-For').not.toMatch(/x_forwarded_for/)
    expect(body).toContain('$ip_anon')
  })

  it('усечение только в журнале — ограничение частоты считает по полному адресу', () => {
    // Если ключ зоны переписать на усечённый адрес, под один счётчик попадёт целая подсеть
    // провайдера, и лимит станет общим на сотни человек. Приватность журнала этого не требует.
    for (const zone of ['zone=demo:', 'zone=demo_conn:', 'zone=login:']) {
      const at = nginx.indexOf(zone)
      expect(at, `зона ${zone} исчезла`).toBeGreaterThan(-1)
      const line = nginx.slice(nginx.lastIndexOf('\n', at) + 1, nginx.indexOf(';', at))
      expect(line, `зона ${zone} считает по усечённому адресу`).toContain('$binary_remote_addr')
    }
  })
})

describe('#413: содержимое демо-документа не попадает в постоянное хранилище', () => {
  const route = read('../server/api/demo/extract.post.ts')

  it('файл пишется ТОЛЬКО во временный каталог и удаляется в finally', () => {
    // ⚠ Формулировка приёмки в issue — «обработка строго in-memory» — невыполнима буквально:
    // pdftotext/tesseract/libreoffice читают файл с диска, это внешние программы. Поэтому
    // проверяется исполнимое утверждение: единственная запись идёт во временный каталог, и её
    // удаление стоит в `finally` — то есть переживает и ошибку разбора, и отказ модели.
    expect(route, 'путь записи не через временный каталог').toMatch(/DEMO_TMP/)
    expect(route, 'временный каталог не из tmp').toMatch(/\/tmp\//)
    const core = read('../server/utils/demoAi.ts')
    expect(core, 'удаление не в finally — файл переживёт ошибку').toMatch(/finally\s*\{[\s\S]{0,200}cleanup/)
  })

  it('в базу и в Redis уходит только статус задания, без содержимого документа', () => {
    // Демо живёт на своём сторе (`demoJobStore`), а не на портальном: у последнего другой TTL и
    // другой состав. Проверяем, что маршрут не трогает ни портальный стор, ни Postgres.
    expect(route, 'демо пишет в портальный стор заданий').not.toMatch(/from '\.\.\/\.\.\/utils\/jobStore'/)
    expect(route, 'демо ходит в Postgres').not.toMatch(/queryFn|getPool|from '\.\.\/\.\.\/db\//)
  })

  it('у демо свой кап страниц скана — втрое ниже портального', () => {
    // Каждая страница скана в демо это секунды OCR (держат один из двух слотов) и токены из
    // общего суточного бюджета. Портальный кап защищает инфраструктуру, демо-кап — наш кошелёк.
    const runners = read('../server/utils/extractRunners.ts')
    expect(runners).toMatch(/MAX_DEMO_OCR_PDF_PAGES = \d+/)
    const demoCap = Number(runners.match(/MAX_DEMO_OCR_PDF_PAGES = (\d+)/)?.[1])
    const portalCap = Number(runners.match(/MAX_OCR_PDF_PAGES = (\d+)/)?.[1])
    expect(demoCap).toBeGreaterThan(0)
    expect(demoCap, 'демо-кап не ниже портального — тогда он бессмыслен').toBeLessThan(portalCap)
    // И демо обязано использовать СВОИ раннеры: подмена на портальные снимает кап молча.
    expect(route, 'демо ходит портальными раннерами').not.toContain('liveExtractRunners')
    expect(route).toContain('demoExtractRunners')
  })
})
