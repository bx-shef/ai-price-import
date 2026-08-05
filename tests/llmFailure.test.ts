import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_FAILURE_KINDS, classifyLlmFailure, describeLlmFailure, llmErrorSignature, llmFailureMessage, ownFailure, type LlmFailureKind } from '../server/agent/llmFailure'
import { handleAgentRunJob } from '../server/queue/handlers'
import { checkBackendEnv } from '../server/utils/envCheck'
import { MAX_CHAT_REASON } from '../server/utils/chatNotify'

// #416. П. 8.4 EULA обещает, что приложение сообщает об отказах в чат Портала. Механика для этого
// была и раньше; проверяется здесь другое — что именно доезжает до человека и что НЕ доезжает.

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

// ⚠ Список берётся ИЗ МОДУЛЯ, а не переписывается здесь: третья рукописная копия разъехалась бы с
// таблицей текстов молча — новый класс просто не попал бы ни в одну проверку.
const ALL_KINDS: LlmFailureKind[] = [...PROVIDER_FAILURE_KINDS]

describe('#416: класс отказа по строке провайдера', () => {
  it.each([
    ['429 Too Many Requests', 'quota'],
    ['insufficient_quota: You exceeded your current quota', 'quota'],
    ['401 Unauthorized', 'auth'],
    ['invalid_api_key', 'auth'],
    // Это наша собственная строка из openaiChat, когда ключ не задан вовсе. Класс тот же —
    // для человека «ключ не тот» и «ключа нет» неразличимы и чинятся одним действием.
    ['LLM provider \'bitrixgpt\' not configured (missing API key)', 'auth'],
    ['503 Service Unavailable', 'unavailable'],
    ['ECONNRESET', 'unavailable'],
    ['socket hang up', 'unavailable'],
    ['context_length_exceeded: maximum context length is 128000 tokens', 'too-long'],
    ['агент не извлёк табличную часть', 'unparsable'],
    ['Unexpected token < in JSON at position 0', 'unparsable']
  ] as Array<[string, LlmFailureKind]>)('«%s» → %s', (raw, kind) => {
    expect(classifyLlmFailure(raw)).toBe(kind)
  })

  it('квота выигрывает у общего 4xx — совет человеку разный', () => {
    // «429 insufficient_quota» это одновременно лимит и 4xx. Совет «попробуйте позже» и совет
    // «позовите издателя» — разные действия, поэтому порядок проверок значим.
    expect(classifyLlmFailure('429 insufficient_quota')).toBe('quota')
  })

  it('неузнанное — unknown, а не выдуманный диагноз', () => {
    // Выдуманная причина хуже честного «не определена»: она уводит человека чинить не то.
    expect(classifyLlmFailure('нечто совершенно новое')).toBe('unknown')
    expect(classifyLlmFailure('')).toBe('unknown')
    expect(classifyLlmFailure(undefined)).toBe('unknown')
  })
})

describe('#416: текст для сотрудника', () => {
  it('у каждого класса свой непустой текст', () => {
    const seen = new Set(ALL_KINDS.map(k => llmFailureMessage(k)))
    expect(seen.size, 'два класса дают одинаковый текст — тогда классификация бессмысленна').toBe(ALL_KINDS.length)
    for (const k of ALL_KINDS) expect(llmFailureMessage(k).length).toBeGreaterThan(20)
  })

  it('текст помещается в предел чата целиком', () => {
    // Чат режет строку на MAX_CHAT_REASON. Обрыв ровно перед советом, что делать, уже случался
    // (#373) — тогда сообщение обрывалось перед словами «запись не создана».
    for (const k of ALL_KINDS) {
      expect(llmFailureMessage(k).length, `текст класса ${k} длиннее предела чата`).toBeLessThanOrEqual(MAX_CHAT_REASON)
    }
  })

  it('ни один текст не обещает автоматического повтора', () => {
    // Очередей отложенных повторов в проекте нет намеренно (решение владельца): отказ извлечения
    // терминальный. Обещание «попробуем сами» заставило бы человека ждать того, чего не будет.
    for (const k of ALL_KINDS) {
      const m = llmFailureMessage(k)
      expect(m, `текст класса ${k} обещает повтор`).not.toMatch(/повторим|попробуем (?:сами|позже)|автоматически повтор(?!а нет)/i)
    }
  })

  it('о неполадках на нашей стороне сказано, что они наши', () => {
    // «Не обвинять клиента в том, что от него не зависит»: квота, ключ и доступность — сторона
    // приложения, и человек не должен искать причину в своём документе.
    expect(llmFailureMessage('quota')).toMatch(/на стороне приложения/i)
    expect(llmFailureMessage('auth')).toMatch(/на нашей стороне/i)
  })

  it('в текстах нет ни кодов, ни имён провайдеров', () => {
    // Имя провайдера в чате клиента — это раскрытие подрядчика там, где оно ничего не даёт;
    // код ответа человеку не говорит ничего.
    for (const k of ALL_KINDS) {
      const m = llmFailureMessage(k)
      expect(m).not.toMatch(/bitrixgpt|deepseek|openai/i)
      expect(m, `текст класса ${k} несёт код ответа`).not.toMatch(/\b[45]\d\d\b/)
    }
  })
})

describe('#416: строка провайдера не покидает сервер', () => {
  it('обработчик отдаёт НАШ текст, а не то, что прислал провайдер', async () => {
    // Мутация «передать `error` в failJob как раньше» — ровно то, что этот тест ловит: она не
    // ломает ни один другой тест, потому что задание точно так же становится 'error'.
    const failed: string[] = []
    await handleAgentRunJob({ memberId: 'm', jobId: 'j' } as never, {
      getDocumentText: async () => 'текст документа',
      extractDocument: async () => ({ document: null, error: '429 insufficient_quota for org-XYZ' }),
      saveDocument: async () => {},
      enqueueCrmSync: async () => {},
      failJob: async (_m, _j, reason) => { failed.push(reason) }
    })
    expect(failed).toHaveLength(1)
    expect(failed[0]).toBe(llmFailureMessage('quota'))
    expect(failed[0], 'строка провайдера доехала до сотрудника').not.toContain('org-XYZ')
    expect(failed[0]).not.toContain('429')
  })

  it('в журнал уходит класс и просеянная подпись, а не сырая строка', async () => {
    const logged: Array<[string, string]> = []
    await handleAgentRunJob({ memberId: 'm', jobId: 'j' } as never, {
      getDocumentText: async () => 'текст',
      extractDocument: async () => ({ document: null, error: '400 bad request: ООО «Ромашка», сахар-песок 25 кг' }),
      saveDocument: async () => {},
      enqueueCrmSync: async () => {},
      failJob: async () => {},
      logLlmFailure: (kind, signature) => { logged.push([kind, signature]) }
    })
    expect(logged).toHaveLength(1)
    // Тело ответа провайдера вправе процитировать присланный запрос, а в запросе — документ
    // клиента. Журнал такое же хранилище, как база (#413).
    expect(logged[0]![1]).not.toMatch(/Ромашка|сахар/)
    expect(logged[0]![1]).toContain('400')
  })

  it('подпись выбрасывает кириллицу по построению, а не по внимательности', () => {
    const sig = llmErrorSignature('Error 502: поставщик ООО «Заря», позиция «мука пшеничная»')
    expect(sig).not.toMatch(/[А-Яа-яЁё]/)
    expect(sig).toContain('502')
    expect(llmErrorSignature('x'.repeat(500)).length).toBeLessThanOrEqual(120)
  })

  // Строки НАСТОЯЩИЕ: сняты живым прогоном `pnpm verify:chat` с заведомо неверным ключом
  // (2026-08-04). Регулярки написаны по догадке о формулировках — без этой пары они были бы
  // проверены только сами на себе.
  const LIVE_AUTH = [
    '401 401 API key required. Use X-Api-Key header instead of Authorization: Bearer. Bearer is only supported for Vibe keys (vibe_*).',
    '401 401 Authentication Fails, Your api key: ****alid is invalid'
  ]

  it.each(LIVE_AUTH)('живой отказ провайдера распознаётся как auth: %s', (raw) => {
    expect(classifyLlmFailure(raw)).toBe('auth')
  })

  it('эхо ключа из ответа провайдера не доезжает до журнала', () => {
    // Найдено ЖИВЫМ прогоном: DeepSeek отвечает «Your api key: ****alid is invalid», а фильтр
    // символов выбрасывал звёздочки и оставлял хвост настоящего ключа. Порядок «сначала редакция
    // ключа, потом фильтр» держит именно этот случай.
    const sig = llmErrorSignature('401 Authentication Fails, Your api key: ****sk3Ta1L is invalid')
    expect(sig).not.toContain('sk3Ta1L')
    expect(sig).toContain('<hidden>')
    expect(sig).toContain('401')
  })

  it('describeLlmFailure — одна дверь: класс и текст всегда согласованы', () => {
    const d = describeLlmFailure('503 upstream')
    expect(d.kind).toBe('unavailable')
    expect(d.message).toBe(llmFailureMessage('unavailable'))
  })
})

describe('#416: провайдер проверяется на старте', () => {
  const base = { B24_TOKEN_ENC_KEY: Buffer.alloc(32).toString('base64'), DATABASE_URL: 'postgres://x', VIBE_API_KEY: 'k' }

  it('неизвестное значение — фатально, сервис не поднимается', () => {
    // `resolveLlmProvider` молча падает на дефолт: портал, которому обещали DeepSeek, годами
    // ходил бы в BitrixGPT. Политика называет провайдера поимённо — она бы врала.
    const r = checkBackendEnv({ ...base, LLM_PROVIDER: 'openai' })
    expect(r.fatal.length).toBe(1)
    expect(r.fatal[0]).toMatch(/LLM_PROVIDER/)
  })

  it('custom без признака self-hosted — фатально', () => {
    // В облаке это третий, неназванный получатель текста документов против п. 5.3 Политики.
    expect(checkBackendEnv({ ...base, LLM_PROVIDER: 'custom' }).fatal.length).toBe(1)
    expect(checkBackendEnv({ ...base, LLM_PROVIDER: 'custom', SELF_HOSTED: '1' }).fatal).toEqual([])
  })

  it('два облачных провайдера поднимаются, пустое значение — тоже (дефолт)', () => {
    for (const p of ['bitrixgpt', 'deepseek', '', undefined]) {
      const env = { ...base, DEEPSEEK_API_KEY: 'k', ...(p === undefined ? {} : { LLM_PROVIDER: p }) }
      expect(checkBackendEnv(env).fatal, `провайдер '${p}' объявлен фатальным`).toEqual([])
    }
  })

  it('нет ключа — ошибка, но НЕ остановка сервиса', () => {
    // Приложение обязано подняться: установка, настройки и чат работают, а каждый документ
    // получит внятный отказ «ключ недействителен». Рестарт-цикл вместо этого — хуже.
    const r = checkBackendEnv({ ...base, VIBE_API_KEY: '', LLM_PROVIDER: 'bitrixgpt' })
    expect(r.fatal).toEqual([])
    expect(r.errors.some(e => /BITRIXGPT_API_KEY/.test(e))).toBe(true)
  })

  it('плагин действительно роняет процесс на фатальном, а не только логирует', () => {
    // Мутация «убрать throw» оставила бы тесты выше зелёными: они проверяют чистую функцию,
    // а не то, что кто-то смотрит на её результат.
    const plugin = read('../server/plugins/envCheck.ts')
    expect(plugin).toMatch(/fatal\.length/)
    expect(plugin).toMatch(/throw new Error/)
  })

  it('список известных провайдеров совпадает с тем, что умеет резолвер', () => {
    // Разъехавшись, они дали бы худший исход из двух: гейт пропускает провайдера, которого код
    // не знает, и тот молча уходит в дефолт — ровно то, что гейт и должен предотвращать.
    const cfg = read('../server/agent/llmConfig.ts')
    const declared = /LlmProvider\s*=\s*([^\n]+)/.exec(cfg)?.[1] ?? ''
    for (const p of ['bitrixgpt', 'deepseek', 'custom']) {
      expect(declared, `резолвер не знает провайдера ${p}`).toContain(`'${p}'`)
    }
    const gate = read('../server/utils/envCheck.ts')
    const known = /KNOWN_PROVIDERS = \[([^\]]+)\]/.exec(gate)?.[1] ?? ''
    for (const p of ['bitrixgpt', 'deepseek', 'custom']) expect(known).toContain(`'${p}'`)
  })
})

describe('#416: отказ по-прежнему доезжает до чата', () => {
  it('обработчик зовёт failJob, а тот и есть путь до чата ошибок', async () => {
    // Сама доставка не менялась (`failJob` → `notifyImportFailure` → `planFailureNotify`), но
    // без этой проверки правка «просто записать статус» тихо отключила бы обещание п. 8.4 EULA.
    const failJob = vi.fn(async () => {})
    await handleAgentRunJob({ memberId: 'm', jobId: 'j' } as never, {
      getDocumentText: async () => 'текст',
      extractDocument: async () => ({ document: null, error: '503' }),
      saveDocument: async () => {},
      enqueueCrmSync: async () => {},
      failJob
    })
    expect(failJob).toHaveBeenCalledOnce()
    const wiring = read('../server/queue/liveDeps.ts')
    expect(wiring, 'failJob перестал уведомлять').toMatch(/failJob:[\s\S]{0,220}notifyImportFailure/)
  })
})

describe('#416: ловушки классификации, найденные разбором', () => {
  // Каждая строка ниже — реальный ответ провайдера, на котором прежний порядок правил давал НЕВЕРНЫЙ
  // совет. Тест закрепляет именно исход, а не порядок в таблице: порядок — деталь реализации.
  it.each([
    ['401 Unauthorized, contact billing support', 'auth'],
    ['400 prompt is too long: 300000 tokens', 'too-long'],
    ['502 Bad Gateway <html>unexpected token <', 'unavailable'],
    ['429 You exceeded your current quota, insufficient_quota', 'quota']
  ])('«%s» → %s', (raw, kind) => {
    expect(classifyLlmFailure(raw)).toBe(kind)
  })

  it('наш собственный отказ доезжает СВОИМ текстом, а не подменяется советом про провайдера', () => {
    // ⚠ Мутация «убрать ownFailure из chatExtract» вернула бы сотруднику совет «попробуйте позже»
    // вместо «разделите файл» — то есть ровно неверное действие.
    const mine = ownFailure('Импорт остановлен: в документе больше 10 000 строк товаров.')
    const { kind, message } = describeLlmFailure(mine)
    expect(kind).toBe('own')
    expect(message).toBe('Импорт остановлен: в документе больше 10 000 строк товаров.')
  })

  it('«own» не попадает в список классов провайдера', () => {
    expect(PROVIDER_FAILURE_KINDS).not.toContain('own')
  })
})
