import { describe, expect, it } from 'vitest'
import { resolveAgentEngine, resolveLlmConfig, resolveLlmProvider } from '../server/agent/llmConfig'

describe('resolveLlmProvider', () => {
  it('accepts the known providers case-insensitively', () => {
    expect(resolveLlmProvider('deepseek')).toBe('deepseek')
    expect(resolveLlmProvider('BitrixGPT')).toBe('bitrixgpt')
    expect(resolveLlmProvider(' custom ')).toBe('custom')
  })
  it('defaults to deepseek for unknown/empty', () => {
    expect(resolveLlmProvider(undefined)).toBe('deepseek')
    expect(resolveLlmProvider('')).toBe('deepseek')
    expect(resolveLlmProvider('gpt4')).toBe('deepseek')
  })
})

describe('resolveAgentEngine', () => {
  it('returns chat only for the exact opt-in, else claude', () => {
    expect(resolveAgentEngine('chat')).toBe('chat')
    expect(resolveAgentEngine(' CHAT ')).toBe('chat')
    expect(resolveAgentEngine('claude')).toBe('claude')
    expect(resolveAgentEngine(undefined)).toBe('claude')
    expect(resolveAgentEngine('openai')).toBe('claude')
  })
})

describe('resolveLlmConfig', () => {
  it('deepseek preset with env key; base/model default', () => {
    const c = resolveLlmConfig({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-ds' })
    expect(c).toEqual({ provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-ds', model: 'deepseek-chat', label: 'deepseek' })
  })

  it('bitrixgpt preset; falls back to VIBE_API_KEY and the bitrix model', () => {
    const c = resolveLlmConfig({ LLM_PROVIDER: 'bitrixgpt', VIBE_API_KEY: 'vibe_api_x' })
    expect(c.provider).toBe('bitrixgpt')
    expect(c.baseURL).toBe('https://vibecode.bitrix24.tech/v1')
    expect(c.model).toBe('bitrix/bitrixgpt-5.5')
    expect(c.apiKey).toBe('vibe_api_x')
  })

  it('a dedicated BITRIXGPT_API_KEY wins over VIBE_API_KEY', () => {
    const c = resolveLlmConfig({ LLM_PROVIDER: 'bitrixgpt', BITRIXGPT_API_KEY: 'dedicated', VIBE_API_KEY: 'shared' })
    expect(c.apiKey).toBe('dedicated')
  })

  it('env overrides base URL and model per provider', () => {
    const c = resolveLlmConfig({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k', DEEPSEEK_BASE_URL: 'https://proxy/v1', DEEPSEEK_MODEL: 'deepseek-reasoner' })
    expect(c.baseURL).toBe('https://proxy/v1')
    expect(c.model).toBe('deepseek-reasoner')
  })

  it('custom provider is fully explicit (no built-in defaults)', () => {
    const c = resolveLlmConfig({ LLM_PROVIDER: 'custom', LLM_BASE_URL: 'https://x/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_LABEL: 'mine' })
    expect(c).toEqual({ provider: 'custom', baseURL: 'https://x/v1', apiKey: 'k', model: 'm', label: 'mine' })
  })

  it('missing key yields apiKey:"" (fail-closed — the live adapter errors clearly)', () => {
    expect(resolveLlmConfig({ LLM_PROVIDER: 'deepseek' }).apiKey).toBe('')
    expect(resolveLlmConfig({ LLM_PROVIDER: 'bitrixgpt' }).apiKey).toBe('')
  })

  it('unknown LLM_PROVIDER defaults to the deepseek preset', () => {
    expect(resolveLlmConfig({ DEEPSEEK_API_KEY: 'k' }).provider).toBe('deepseek')
  })
})
