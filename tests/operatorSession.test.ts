import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { OP_MAX_AGE_MS, operatorAllowed, opsCheckToken, opsQueuesAllowed, opsTokenOk } from '../server/utils/operatorSession'
import { signSession } from '../server/utils/session'

const env = { OPERATOR_PASSWORD: 'p', OPERATOR_SESSION_SECRET: 'sekret' }

describe('operatorAllowed', () => {
  it('true for a fresh valid cookie', () => {
    const cookie = signSession('sekret', 1_000_000)
    expect(operatorAllowed(cookie, env, 1_000_000 + 5000)).toBe(true)
  })
  it('false for missing / tampered / expired cookie', () => {
    expect(operatorAllowed(undefined, env, 1)).toBe(false)
    expect(operatorAllowed('garbage', env, 1)).toBe(false)
    const cookie = signSession('sekret', 1000)
    expect(operatorAllowed(cookie, env, 1000 + OP_MAX_AGE_MS + 1)).toBe(false) // expired
    expect(operatorAllowed(cookie, { OPERATOR_SESSION_SECRET: 'other' }, 2000)).toBe(false) // wrong secret
  })
})

describe('opsTokenOk', () => {
  it('constant-time match; fail-closed when the expected token is unset', () => {
    expect(opsTokenOk('secret-token', 'secret-token')).toBe(true)
    expect(opsTokenOk('secret-token', 'nope')).toBe(false)
    expect(opsTokenOk('', '')).toBe(false) // unset ⇒ deny (empty header must not pass)
    expect(opsTokenOk('', 'anything')).toBe(false)
  })
})

describe('служебный роут /api/queues: свой токен и живой гейт', () => {
  const read = (s: string) => readFileSync(new URL(s, import.meta.url), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')

  it('читается OPS_CHECK_TOKEN, а B24_APPLICATION_TOKEN игнорируется', () => {
    // ⚠ Мутация «вернуть B24_APPLICATION_TOKEN» переживала весь набор: роут не был покрыт вовсе.
    // Возврат означал бы секрет с двумя смыслами — заполнив его ради мониторинга, администратор
    // снова ломал бы установку клиентам.
    expect(opsCheckToken({ OPS_CHECK_TOKEN: 'ops' })).toBe('ops')
    expect(opsCheckToken({ B24_APPLICATION_TOKEN: 'app' })).toBe('')
    expect(opsQueuesAllowed({ B24_APPLICATION_TOKEN: 'app' }, 'app')).toBe(false)
  })

  it('гейт живой: без токена не пускает, с верным пускает', () => {
    expect(opsQueuesAllowed({ OPS_CHECK_TOKEN: 'ops' }, '')).toBe(false)
    expect(opsQueuesAllowed({ OPS_CHECK_TOKEN: 'ops' }, 'nope')).toBe(false)
    expect(opsQueuesAllowed({ OPS_CHECK_TOKEN: 'ops' }, 'ops')).toBe(true)
    // Пусто ⇒ закрыт: «не настроили» не должно читаться как «пускать всех».
    expect(opsQueuesAllowed({}, '')).toBe(false)
    expect(opsQueuesAllowed({}, 'anything')).toBe(false)
  })

  it('роут зовёт гейт ДО чтения очередей и не читает старую переменную', () => {
    // Мутация «снять гейт» (`if (false && …)`) не роняла ничего — про роут не спрашивал никто.
    const src = read('../server/api/queues.get.ts')
    expect(src, 'вернулась переменная с двумя смыслами').not.toContain('B24_APPLICATION_TOKEN')
    // ⚠ Индексы ищутся по ВЫЗОВАМ, а не по первому вхождению имени: импорт стоит выше любого кода,
    // и сравнение с ним всегда истинно — проверка была бы декоративной.
    const gate = src.indexOf('!opsQueuesAllowed(')
    const work = src.indexOf('await readQueueCounts(')
    expect(gate).toBeGreaterThan(-1)
    expect(gate, 'очереди читаются раньше проверки доступа').toBeLessThan(work)
    expect(src, 'проверка обесточена').toMatch(/if\s*\(\s*!opsQueuesAllowed/)
  })
})

describe('глобального гейта установки нет ни в ядре, ни на шве', () => {
  const read = (s: string) => readFileSync(new URL(s, import.meta.url), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')

  // ⚠ Проверка по подписи функции ловила только возврат ПАРАМЕТРА. Гейт можно вернуть и мимо неё —
  // прочитав `process.env` внутри ядра или восстановив проверку в самом роуте: тогда у всех
  // порталов, кроме одного, первая установка снова молча отвечает 403.
  it.each([
    ['../server/utils/b24EventsHandler.ts'],
    ['../server/api/b24/events.post.ts']
  ])('%s не читает B24_APPLICATION_TOKEN', (file) => {
    expect(read(file)).not.toContain('B24_APPLICATION_TOKEN')
  })
})
