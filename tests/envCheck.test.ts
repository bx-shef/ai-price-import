import { describe, expect, it } from 'vitest'
import { checkBackendEnv } from '../server/utils/envCheck'

const key32 = Buffer.alloc(32).toString('base64')

describe('checkBackendEnv', () => {
  it('clean env → no errors', () => {
    const r = checkBackendEnv({
      B24_TOKEN_ENC_KEY: key32,
      DATABASE_URL: 'postgres://x',
      B24_CLIENT_ID: 'id',
      B24_CLIENT_SECRET: 'sec',
      REDIS_URL: 'redis://x',
      // Ключ провайдера — часть чистого окружения с #416: без него распознавание отказывает
      // на каждом документе, и это ошибка конфигурации, а не «нормально по умолчанию».
      VIBE_API_KEY: 'vibe_api_x'
    })
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('flags missing/short key, missing DB', () => {
    const r = checkBackendEnv({ B24_TOKEN_ENC_KEY: Buffer.alloc(16).toString('base64') })
    expect(r.errors.some(e => /32 bytes/.test(e))).toBe(true)
    expect(r.errors.some(e => /DATABASE_URL/.test(e))).toBe(true)
  })

  it('оставленный B24_APPLICATION_TOKEN — предупреждение, а не ошибка и не молчание', () => {
    // ⚠ Переменная больше не читается нигде: `application_token` выдаётся НА УСТАНОВКУ, у каждого
    // портала свой, и общее значение отвечало бы 403 всем тенантам кроме одного. Прежде она вдобавок
    // была паролем служебного роута — то есть заполнение ради служебной страницы ломало установку
    // клиентам. Молчать о ней нельзя: администратор будет считать её работающей защитой.
    const base = { B24_TOKEN_ENC_KEY: key32, DATABASE_URL: 'x', B24_CLIENT_ID: 'i', B24_CLIENT_SECRET: 's', REDIS_URL: 'r', VIBE_API_KEY: 'k' }
    const left = checkBackendEnv({ ...base, B24_APPLICATION_TOKEN: 'realtoken123' })
    expect(left.errors).toEqual([])
    expect(left.warnings.some(w => /B24_APPLICATION_TOKEN/.test(w))).toBe(true)

    const clean = checkBackendEnv(base)
    expect(clean.errors).toEqual([])
    expect(clean.warnings).toEqual([])
  })

  it('warns (not errors) on missing OAuth creds / Redis', () => {
    const r = checkBackendEnv({ B24_TOKEN_ENC_KEY: key32, DATABASE_URL: 'x', B24_APPLICATION_TOKEN: 't', VIBE_API_KEY: 'k' })
    expect(r.errors).toEqual([])
    expect(r.warnings.some(w => /CLIENT_ID/.test(w))).toBe(true)
    expect(r.warnings.some(w => /REDIS_URL/.test(w))).toBe(true)
  })

  it('operator secret: weak → warn; enc-key fallback → key-separation warn; strong → none', () => {
    const base = { B24_TOKEN_ENC_KEY: key32, DATABASE_URL: 'x', B24_APPLICATION_TOKEN: 't', B24_CLIENT_ID: 'i', B24_CLIENT_SECRET: 's', REDIS_URL: 'r' }
    // weak explicit secret
    expect(checkBackendEnv({ ...base, OPERATOR_PASSWORD: 'p', OPERATOR_SESSION_SECRET: 'short' }).warnings.some(w => /weak/.test(w))).toBe(true)
    // fallback to enc key (strong length) → key-separation warning
    expect(checkBackendEnv({ ...base, OPERATOR_PASSWORD: 'p' }).warnings.some(w => /key separation/.test(w))).toBe(true)
    // strong dedicated secret → no operator warning
    expect(checkBackendEnv({ ...base, OPERATOR_PASSWORD: 'p', OPERATOR_SESSION_SECRET: 'a-strong-secret-32-characters-long' }).warnings.some(w => /secret/i.test(w))).toBe(false)
    // no operator password → no operator warnings at all
    expect(checkBackendEnv({ ...base, OPERATOR_SESSION_SECRET: 'short' }).warnings.some(w => /OPERATOR/.test(w))).toBe(false)
  })

  it('warns on an invalid QUEUE_*_CONCURRENCY, stays quiet when unset or valid (GH #95)', () => {
    const base = { B24_TOKEN_ENC_KEY: key32, DATABASE_URL: 'x', B24_CLIENT_ID: 'i', B24_CLIENT_SECRET: 's', REDIS_URL: 'r' }
    expect(checkBackendEnv({ ...base, QUEUE_EXTRACT_CONCURRENCY: 'abc' }).warnings.some(w => /QUEUE_EXTRACT_CONCURRENCY/.test(w))).toBe(true)
    expect(checkBackendEnv({ ...base, QUEUE_AGENT_CONCURRENCY: '0' }).warnings.some(w => /QUEUE_AGENT_CONCURRENCY/.test(w))).toBe(true)
    expect(checkBackendEnv({ ...base }).warnings.some(w => /CONCURRENCY/.test(w))).toBe(false) // unset = fine
    expect(checkBackendEnv({ ...base, QUEUE_CRM_CONCURRENCY: '2' }).warnings.some(w => /CONCURRENCY/.test(w))).toBe(false) // valid
  })
})

describe('#416: адрес провайдера в облаке подменять нельзя', () => {
  // ⚠ Гейт заведён ради юридического инварианта: п. 5.3 Политики называет получателей поимённо, а
  // `LLM_PROVIDER=bitrixgpt` + `BITRIXGPT_BASE_URL=https://кто-угодно/v1` проходил гейт `custom` —
  // сервис поднимался, тексты документов уходили третьему лицу, а журнал писал «bitrixgpt».
  // Мутация «вырезать весь блок» не роняла НИ ОДНОГО теста.
  const key32 = Buffer.alloc(32).toString('base64')
  const base = { B24_TOKEN_ENC_KEY: key32, DATABASE_URL: 'x', B24_APPLICATION_TOKEN: 't', B24_CLIENT_ID: 'i', B24_CLIENT_SECRET: 's', REDIS_URL: 'r', VIBE_API_KEY: 'k' }

  it.each(['DEEPSEEK_BASE_URL', 'BITRIXGPT_BASE_URL', 'LLM_BASE_URL'])('%s в облаке — фатально', (key) => {
    const r = checkBackendEnv({ ...base, [key]: 'https://elsewhere.example/v1' })
    expect(r.fatal.some(f => f.includes(key)), `${key} не проверяется`).toBe(true)
  })

  it('при SELF_HOSTED=1 это законно — инверсия условия сломала бы инсталляцию клиента', () => {
    const r = checkBackendEnv({ ...base, SELF_HOSTED: '1', LLM_BASE_URL: 'https://internal.example/v1', BITRIXGPT_BASE_URL: 'https://internal.example/v1' })
    expect(r.fatal).toEqual([])
  })

  it('пустое значение не фатально — иначе закомментированная строка роняла бы старт', () => {
    const r = checkBackendEnv({ ...base, LLM_BASE_URL: '   ' })
    expect(r.fatal).toEqual([])
  })
})
