import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildFrameHeaders, fetchErrorMessage, frameAuthMessage } from '../app/utils/frameHeaders'

describe('buildFrameHeaders', () => {
  it('builds the exact headers extractFrameAuth parses, or null', () => {
    expect(buildFrameHeaders({ accessToken: 'tok', domain: 'p.bitrix24.by' }))
      .toEqual({ 'Authorization': 'Bearer tok', 'X-B24-Domain': 'p.bitrix24.by' })
    expect(buildFrameHeaders(null)).toBeNull()
  })
})

describe('fetchErrorMessage', () => {
  it('surfaces the server {error} body, else the fallback', () => {
    expect(fetchErrorMessage({ data: { error: 'файл слишком большой' } }, 'fb')).toBe('файл слишком большой')
    expect(fetchErrorMessage({ data: {} }, 'fb')).toBe('fb')
    expect(fetchErrorMessage({ data: { error: '   ' } }, 'fb')).toBe('fb') // blank → fallback
    expect(fetchErrorMessage(new Error('boom'), 'fb')).toBe('fb')
    expect(fetchErrorMessage(null, 'fb')).toBe('fb')
  })
})

describe('#345: протухший фрейм-токен — это не «открыто не в Битрикс24»', () => {
  it('внутри портала предлагает то, что помогает', () => {
    // Симптом с живого прогона: приложение открыто в портале и оставлено висеть; фрейм-авторизация
    // живёт около часа, дальше SDK отдаёт `false` вместо токена, и человек, СМОТРЯЩИЙ на приложение
    // внутри портала, читал «доступно только внутри портала Bitrix24». Сообщение не просто
    // бесполезное — оно противоречит тому, что человек видит.
    const msg = frameAuthMessage(true, 'Импорт доступен')
    expect(msg).toMatch(/сессия портала истекла/i)
    expect(msg).toMatch(/обновите страницу/i)
    expect(msg).not.toMatch(/только внутри портала/i)
  })

  it('вне портала прежний текст верен и остаётся — вместе с согласованием', () => {
    // ⚠ Первая версия склеивала фиксированное «доступен» с существительным вызывающего и давала
    // «Настройки доступен», хотя до правки там стояло верное «Настройки доступны». Хуже: тест
    // закреплял сломанную форму, то есть починка грамматики роняла бы CI.
    expect(frameAuthMessage(false, 'Настройки доступны')).toBe('Настройки доступны только внутри портала Bitrix24')
    expect(frameAuthMessage(false, 'Импорт доступен')).toBe('Импорт доступен только внутри портала Bitrix24')
  })
})

describe('#345: токен обновляется, а не «сдаёмся»', () => {
  const b24 = readFileSync(new URL('../app/composables/useB24.ts', import.meta.url), 'utf8')

  /** Тело `ensureAuth`, без окружающих комментариев: «упоминается в JSDoc» — не то же, что «зовётся». */
  const ensureBody = b24.slice(b24.indexOf('async function ensureAuth'), b24.indexOf('async function ensureAuth') + 900)
  /** Тело общего обновления — там, где живёт сам вызов SDK. */
  const refreshBody = b24.slice(b24.indexOf('function refreshOnce'), b24.indexOf('function refreshOnce') + 700)

  it('у SDK просят обновить авторизацию', () => {
    // Мутация «убрать refreshAuth» вернула бы ровно дефект: один вызов чинит ситуацию, а вместо
    // него человек получал отказ и терял всю пачку файлов. ⚠ Первая версия проверки искала имя по
    // ВСЕМУ файлу и находила его в комментарии — то есть сторожила документацию, а не вызов.
    expect(refreshBody).toMatch(/f\.auth\.refreshAuth\(\)/)
    expect(ensureBody).toMatch(/refreshOnce\(/)
  })

  it('обновление одно на всех и с пределом ожидания', () => {
    // Замерено разбором: тринадцать композаблов монтируются вместе, и без общего обещания истёкший
    // час давал тринадцать одновременных обновлений. А `refreshAuth` таймаута не ставит вовсе —
    // если родитель не ответил, обещание не разрешится НИКОГДА: пикеры крутятся вечно, пачка висит
    // под баннером «не закрывайте страницу» без единой ошибки. Это хуже неверного текста.
    expect(refreshBody).toMatch(/if \(!refreshPromise\)/)
    expect(refreshBody).toMatch(/Promise\.race/)
    expect(refreshBody).toMatch(/setTimeout/)
    expect(refreshBody).toMatch(/refreshPromise = null/)
  })

  it('сбой обновления не остаётся немым', () => {
    // Три разные причины (портал отказал, родитель молчит, SDK не готов) из браузера неотличимы, а
    // живой отладки внутри фрейма нет. Токен при этом не логируется.
    expect(ensureBody).toMatch(/console\.warn/)
  })

  it('SDK поднимается сам, а не «вызывающий наверняка это сделал»', () => {
    // `useAppRating.report()` уже полагался на то, что раньше отработал `check()`; вызов в другом
    // порядке молча получал бы null без единой попытки.
    expect(ensureBody).toMatch(/await init\(\)/)
  })

  it('обновление пробуется ТОЛЬКО во фрейме', () => {
    // Вне портала обновлять нечего, и лишний вызов в SDK, который не инициализирован, — это ошибка
    // в консоли на каждой публичной странице.
    expect(ensureBody).toMatch(/if \(!inFrame\(\)/)
  })

  it('все фрейм-композаблы ходят через обновляющий путь', () => {
    // Иначе через месяц будет шесть разных полуфиксов — ровно то, чего issue просит избежать.
    const dir = new URL('../app/composables/', import.meta.url)
    const files = ['useImport.ts', 'useSettings.ts', 'useMetrics.ts', 'useAppRating.ts', 'useCrmMode.ts',
      'useCatalogMeasures.ts', 'useCatalogProperties.ts', 'useChatSearch.ts', 'useChatBotStatus.ts',
      'useCrmStages.ts', 'useCrmTypes.ts', 'useCrmCategories.ts', 'useFeedback.ts']
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), 'utf8')
      expect(src, `${f}: заголовки строятся мимо обновления токена`).not.toMatch(/buildFrameHeaders\(auth\(\)\)/)
    }
  })
})

describe('#345: честный текст стоит на местах отказа, а не только объявлен', () => {
  // Мутация «вернуть прежнюю строку в useImport» проходила: функция-то осталась корректной, её
  // просто перестали звать. Это ровно тот класс, который в этом проекте уже дважды ловили.
  const files = {
    'app/composables/useImport.ts': 'Импорт доступен',
    'app/composables/useSettings.ts': 'Настройки доступны',
    'app/components/FeedbackWidget.vue': 'Отзыв доступен'
  }

  for (const [f, what] of Object.entries(files)) {
    it(`${f} говорит про истёкшую сессию, а не про «не в портале»`, () => {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
      const body = src.split('\n').filter(l => !/^\s*import\b/.test(l) && !l.trim().startsWith('//')).join('\n')
      expect(body, 'прежний текст вернулся литералом').not.toMatch(/только внутри портала Bitrix24/)
      expect(body, 'общий текст не используется').toMatch(new RegExp(`frameAuthMessage\\(inFrame\\(\\), '${what}'\\)`))
    })
  }
})
