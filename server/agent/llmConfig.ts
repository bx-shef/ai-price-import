// Provider config for the OpenAI-compatible chat extractor (variant 2 — replaces the
// claude-code CLI). BOTH supported providers expose an OpenAI-compatible
// /v1/chat/completions, so ONE transport serves both and the provider is chosen by env:
//   • deepseek  — https://api.deepseek.com/v1 (model deepseek-chat); jurisdiction КНР (#215)
//   • bitrixgpt — Bitrix Vibecode AI Router https://vibecode.bitrix24.tech/v1
//                 (model bitrix/bitrixgpt-5.5); jurisdiction is Bitrix's responsibility
//   • custom    — any OpenAI-compatible endpoint via explicit LLM_BASE_URL/KEY/MODEL
// Pure resolver (env injected) → unit-tested. No I/O, no secrets logged.

export type LlmProvider = 'deepseek' | 'bitrixgpt' | 'custom'

export interface LlmConfig {
  provider: LlmProvider
  /** OpenAI-compatible base URL (…/v1). */
  baseURL: string
  /** Provider API key — '' when unset (the live adapter then fails closed with a clear error). */
  apiKey: string
  model: string
  /** Human label for logs/telemetry (never a secret). */
  label: string
}

/** Built-in defaults per provider (base URL + model); overridable by env. */
const PRESETS = {
  deepseek: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  bitrixgpt: { baseURL: 'https://vibecode.bitrix24.tech/v1', model: 'bitrix/bitrixgpt-5.5' }
} as const

/** Coerce a raw env value to a known provider (default deepseek — the current prod provider). */
export function resolveLlmProvider(raw: string | undefined): LlmProvider {
  const v = (raw ?? '').trim().toLowerCase()
  return v === 'deepseek' || v === 'bitrixgpt' || v === 'custom' ? v : 'deepseek'
}

/**
 * Engine selector: 'chat' = the OpenAI-compatible extractor (this module), 'claude' = the
 * legacy claude-code CLI. Default 'claude' keeps prod behaviour unchanged until an operator
 * sets a provider key and flips AGENT_ENGINE=chat (then the claude path is removed — see docs).
 */
export function resolveAgentEngine(raw: string | undefined): 'chat' | 'claude' {
  return (raw ?? '').trim().toLowerCase() === 'chat' ? 'chat' : 'claude'
}

/** Resolve the active provider config from env. A missing key yields apiKey:'' (fail-closed). */
export function resolveLlmConfig(env: Record<string, string | undefined>): LlmConfig {
  const provider = resolveLlmProvider(env.LLM_PROVIDER)
  if (provider === 'deepseek') {
    return {
      provider,
      baseURL: env.DEEPSEEK_BASE_URL?.trim() || PRESETS.deepseek.baseURL,
      apiKey: env.DEEPSEEK_API_KEY?.trim() ?? '',
      model: env.DEEPSEEK_MODEL?.trim() || PRESETS.deepseek.model,
      label: 'deepseek'
    }
  }
  if (provider === 'bitrixgpt') {
    return {
      provider,
      baseURL: env.BITRIXGPT_BASE_URL?.trim() || PRESETS.bitrixgpt.baseURL,
      // The AI Router accepts a Vibecode key (vibe_api_…); allow a dedicated var or the shared VIBE_API_KEY.
      apiKey: env.BITRIXGPT_API_KEY?.trim() || env.VIBE_API_KEY?.trim() || '',
      model: env.BITRIXGPT_MODEL?.trim() || PRESETS.bitrixgpt.model,
      label: 'bitrixgpt'
    }
  }
  // custom — fully explicit, no built-in defaults.
  return {
    provider,
    baseURL: env.LLM_BASE_URL?.trim() ?? '',
    apiKey: env.LLM_API_KEY?.trim() ?? '',
    model: env.LLM_MODEL?.trim() ?? '',
    label: env.LLM_LABEL?.trim() || 'custom'
  }
}
