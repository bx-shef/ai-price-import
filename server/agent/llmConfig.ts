// Provider config for the OpenAI-compatible chat extractor. All supported providers expose an
// OpenAI-compatible /v1/chat/completions, so ONE transport serves them and LLM_PROVIDER picks one:
//   • bitrixgpt — Bitrix Vibecode AI Router https://vibecode.bitrix24.tech/v1 (model
//                 bitrix/bitrixgpt-5.5). DEFAULT — routes to Bitrix, away from direct КНР inference (#215); confirm exact routing/jurisdiction with Bitrix.
//   • deepseek  — https://api.deepseek.com/v1 (model deepseek-v4-flash); faster, jurisdiction КНР (#215)
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
  deepseek: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
  bitrixgpt: { baseURL: 'https://vibecode.bitrix24.tech/v1', model: 'bitrix/bitrixgpt-5.5' }
} as const

/** Coerce a raw env value to a known provider (default bitrixgpt — routes to Bitrix's AI Router,
 *  away from direct КНР inference (#215); the public/Market version runs on it. Owner to confirm
 *  exact routing/jurisdiction with Bitrix — the AI Router may proxy to third-party models). */
export function resolveLlmProvider(raw: string | undefined): LlmProvider {
  const v = (raw ?? '').trim().toLowerCase()
  return v === 'deepseek' || v === 'bitrixgpt' || v === 'custom' ? v : 'bitrixgpt'
}

/** Resolve the active provider config from env. A missing key yields apiKey:'' (fail-closed). */
export function resolveLlmConfig(env: Record<string, string | undefined>): LlmConfig {
  const provider = resolveLlmProvider(env.LLM_PROVIDER)
  if (provider === 'deepseek') {
    return {
      provider,
      baseURL: env.DEEPSEEK_BASE_URL?.trim() || PRESETS.deepseek.baseURL,
      // Prod-safe cutover: the same DeepSeek key was previously stored in ANTHROPIC_AUTH_TOKEN
      // (legacy claude path). Fall back to it so removing the claude engine needs NO prod env
      // change — the key is provider-agnostic; only the endpoint (/v1) and protocol differ.
      apiKey: env.DEEPSEEK_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim() || '',
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
