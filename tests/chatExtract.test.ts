import { describe, expect, it, vi } from 'vitest'
import { buildChatRequest, runChatExtract, type ChatFn } from '../server/agent/chatExtract'

const INSTR = 'извлеки JSON'
const DOC = 'Накладная ... Болт М6 100 шт 0.45'
// A minimal valid ExtractedDocument reply (one item → validateExtractedDocument accepts it).
const OK_JSON = JSON.stringify({
  documentType: 'накладная',
  currency: 'BYN',
  priceIncludesVat: true,
  supplier: { name: 'ООО Ромашка', taxId: '190000000', taxIdKind: 'UNP' },
  items: [{ name: 'Болт М6', article: 'BM6-01', quantity: 100, unit: 'шт', price: 0.45, vatRate: 20 }]
})

const noWait = { sleep: async () => {}, random: () => 0 }

describe('buildChatRequest', () => {
  it('puts instructions as system, document as user, forces JSON, temp 0', () => {
    const r = buildChatRequest('deepseek-chat', INSTR, DOC)
    expect(r.model).toBe('deepseek-chat')
    expect(r.messages).toEqual([
      { role: 'system', content: INSTR },
      { role: 'user', content: DOC }
    ])
    expect(r.temperature).toBe(0)
    expect(r.response_format).toEqual({ type: 'json_object' })
  })
})

describe('runChatExtract', () => {
  it('parses a valid JSON reply into an ExtractedDocument', async () => {
    const chat: ChatFn = async () => OK_JSON
    const out = await runChatExtract({ documentText: DOC, instructions: INSTR, model: 'm' }, { chat, ...noWait })
    expect(out.ok).toBe(true)
    expect(out.attempts).toBe(1)
    expect(out.document?.items?.[0]?.name).toBe('Болт М6')
    expect(out.document?.supplier?.taxId).toBe('190000000')
  })

  it('retries a transient error (429) then succeeds', async () => {
    const chat = vi.fn<ChatFn>()
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockResolvedValueOnce(OK_JSON)
    const out = await runChatExtract({ documentText: DOC, instructions: INSTR, model: 'm' }, { chat, ...noWait })
    expect(out.ok).toBe(true)
    expect(out.attempts).toBe(2)
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('gives up on a terminal error without retrying', async () => {
    const chat = vi.fn<ChatFn>().mockRejectedValue(new Error('401 Unauthorized'))
    const out = await runChatExtract({ documentText: DOC, instructions: INSTR, model: 'm' }, { chat, ...noWait })
    expect(out.ok).toBe(false)
    expect(out.attempts).toBe(1) // 401 is not transient → no retry
    expect(out.error).toContain('401')
  })

  it('exhausts the attempt budget on a persistent transient error', async () => {
    const chat = vi.fn<ChatFn>().mockRejectedValue(new Error('503 overloaded'))
    const out = await runChatExtract({ documentText: DOC, instructions: INSTR, model: 'm', maxAttempts: 3 }, { chat, ...noWait })
    expect(out.ok).toBe(false)
    expect(out.attempts).toBe(3)
    expect(chat).toHaveBeenCalledTimes(3)
  })

  it('a clean reply with no tabular part is terminal (no document)', async () => {
    const chat: ChatFn = async () => JSON.stringify({ documentType: 'счёт', items: [] })
    const out = await runChatExtract({ documentText: DOC, instructions: INSTR, model: 'm' }, { chat, ...noWait })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('табличную часть')
  })

  it('rejects a reply with too many items (hard error, no silent truncation)', async () => {
    const many = { items: Array.from({ length: 10_001 }, (_, i) => ({ name: `p${i}`, quantity: 1, unit: 'шт', price: 1, vatRate: 20 })) }
    const chat: ChatFn = async () => JSON.stringify(many)
    const out = await runChatExtract({ documentText: DOC, instructions: INSTR, model: 'm' }, { chat, ...noWait })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('слишком много позиций')
  })

  it('advances the attempt counter across a retry that ends in a terminal validation fail', async () => {
    // 429 (transient, retried) → then a clean reply with no items (terminal). Proves attempts
    // counts the retry AND the second attempt's validation failure is terminal (no 3rd try).
    const chat = vi.fn<ChatFn>()
      .mockRejectedValueOnce(new Error('429 slow down'))
      .mockResolvedValueOnce(JSON.stringify({ documentType: 'счёт', items: [] }))
    const out = await runChatExtract({ documentText: DOC, instructions: INSTR, model: 'm' }, { chat, ...noWait })
    expect(out.ok).toBe(false)
    expect(out.attempts).toBe(2)
    expect(out.error).toContain('табличную часть')
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('a non-JSON reply is terminal (no tabular part)', async () => {
    const chat: ChatFn = async () => 'извините, не удалось разобрать документ'
    const out = await runChatExtract({ documentText: DOC, instructions: INSTR, model: 'm' }, { chat, ...noWait })
    expect(out.ok).toBe(false)
    expect(out.attempts).toBe(1)
    expect(out.error).toContain('табличную часть')
  })

  it('unwraps JSON even if the model wraps it in stray prose', async () => {
    const chat: ChatFn = async () => `Вот результат:\n${OK_JSON}\nготово`
    const out = await runChatExtract({ documentText: DOC, instructions: INSTR, model: 'm' }, { chat, ...noWait })
    expect(out.ok).toBe(true)
    expect(out.document?.items?.length).toBe(1)
  })
})
