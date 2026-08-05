// Pure boot-time env validation (logged, non-fatal — same convention as the reference).
// See docs/PROCESS.md / reviewer note «нет envCheck».

export interface EnvReport {
  errors: string[]
  warnings: string[]
  /**
   * Misconfiguration the service must NOT start with (#416).
   *
   * Отдельный список, а не «сделать все errors фатальными»: остальные ошибки — это деградация
   * (нет ключа шифрования → часть путей мертва, но приложение обязано подняться, чтобы оператор
   * увидел это на `/queues`, а не гадал по перезапускающемуся контейнеру). Здесь же — случаи,
   * когда поднявшийся сервис ВРЁТ опубликованному документу, а это хуже отсутствия сервиса.
   */
  fatal: string[]
}

/** Провайдеры, которые вообще существуют в коде (`server/agent/llmConfig.ts`). */
const KNOWN_PROVIDERS = ['bitrixgpt', 'deepseek', 'custom']

/** Validate backend env. Returns errors (misconfig) + warnings (degraded). */
export function checkBackendEnv(env: Record<string, string | undefined>): EnvReport {
  const errors: string[] = []
  const warnings: string[] = []
  const fatal: string[] = []

  // Token encryption key must decode to exactly 32 bytes (AES-256).
  const key = env.B24_TOKEN_ENC_KEY ?? ''
  if (!key) {
    errors.push('B24_TOKEN_ENC_KEY is not set')
  } else {
    const len = Buffer.from(key, 'base64').length
    if (len !== 32) errors.push(`B24_TOKEN_ENC_KEY must decode to 32 bytes, got ${len}`)
  }

  if (!env.DATABASE_URL) errors.push('DATABASE_URL is not set')

  // ⚠ B24_APPLICATION_TOKEN БОЛЬШЕ НЕ ЧИТАЕТСЯ НИГДЕ. `application_token` Битрикс выдаёт НА
  // УСТАНОВКУ, то есть у каждого портала свой: одно общее значение могло совпасть максимум с
  // одним тенантом, а всем прочим первая установка отвечала бы 403 — молча и навсегда. Прежде
  // она вдобавок служила паролем служебного роута `/api/queues`, и это худшая часть: заполнив
  // её ради служебной страницы, админ ломал установку клиентам. Служебный роут переведён на
  // свою `OPS_CHECK_TOKEN`. Оставшееся значение ни на что не влияет, но вводит в заблуждение —
  // говорим об этом вслух, а не молчим.
  if ((env.B24_APPLICATION_TOKEN ?? '').trim()) {
    warnings.push('B24_APPLICATION_TOKEN задан, но больше не читается: установку он сломать не может, а служебный роут читает OPS_CHECK_TOKEN. Уберите строку из .env')
  }

  if (!env.B24_CLIENT_ID || !env.B24_CLIENT_SECRET) {
    warnings.push('B24_CLIENT_ID/SECRET unset — event intake works, but token refresh / app.option do not')
  }
  if (!env.REDIS_URL) {
    warnings.push('REDIS_URL unset — queue disabled (synchronous fallback only)')
  }

  // Operator zone: if sign-in is enabled, its session-signing secret must be strong.
  if (env.OPERATOR_PASSWORD) {
    const opSecret = env.OPERATOR_SESSION_SECRET ?? env.B24_TOKEN_ENC_KEY ?? ''
    if (opSecret.length < 16) {
      warnings.push('OPERATOR_PASSWORD is set but the session secret is weak/unset — set a strong OPERATOR_SESSION_SECRET (else cookies are forgeable)')
    } else if (!env.OPERATOR_SESSION_SECRET) {
      warnings.push('OPERATOR_SESSION_SECRET unset — reusing B24_TOKEN_ENC_KEY for session signing (key separation recommended in prod)')
    }
  }

  // Worker concurrency overrides (GH #95): invalid values silently fall back to the default,
  // which on a minimal 2-vCPU host is the very oversubscription the override was meant to fix
  // (a typo → default 4 → OCR false-timeouts). Warn loudly so the operator notices.
  for (const key of ['QUEUE_EXTRACT_CONCURRENCY', 'QUEUE_AGENT_CONCURRENCY', 'QUEUE_CRM_CONCURRENCY']) {
    const raw = env[key]
    if (raw == null || raw === '') continue // unset = use default, fine
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1) {
      warnings.push(`${key}='${raw}' is not a positive integer — ignored, using the default`)
    }
  }

  // ── LLM-провайдер (#416) ────────────────────────────────────────────────────
  // П. 5.3 Политики конфиденциальности НАЗЫВАЕТ двух провайдеров поимённо и утверждает, что иные
  // в облачной версии не используются. Поэтому опечатка в `LLM_PROVIDER` не может тихо
  // деградировать: `resolveLlmProvider` молча падает на дефолт, и портал, которому обещали
  // DeepSeek, годами ходил бы в BitrixGPT — или наоборот. Документ бы врал, а узнать об этом было
  // бы неоткуда. Останов на старте — единственный исход, при котором опубликованный текст остаётся
  // верным.
  const rawProvider = (env.LLM_PROVIDER ?? '').trim().toLowerCase()
  if (rawProvider && !KNOWN_PROVIDERS.includes(rawProvider)) {
    fatal.push(`LLM_PROVIDER='${env.LLM_PROVIDER}' — неизвестный провайдер (допустимы: ${KNOWN_PROVIDERS.join(', ')})`)
  }
  // `custom` — ТОЛЬКО self-hosted (п. 12.3 Политики: там провайдера выбирает клиент своим ключом).
  // В облаке это третий, неназванный получатель текста документов, то есть прямое расхождение с
  // п. 5.3. Требуем явного признака инсталляции клиента — молчаливое «наверное, это self-hosted»
  // и есть та самая тихая третья труба.
  if (rawProvider === 'custom' && (env.SELF_HOSTED ?? '') !== '1') {
    fatal.push('LLM_PROVIDER=custom допустим только в инсталляции клиента — поставьте SELF_HOSTED=1 (в облаке разрешены только bitrixgpt и deepseek, п. 5.3 Политики)')
  }
  // ⚠ Гейт закрывает ИМЯ провайдера, но адрес переопределяется отдельной переменной — и это была
  // дверь рядом с запертой. `LLM_PROVIDER=bitrixgpt` + `BITRIXGPT_BASE_URL=https://кто-угодно/v1`
  // проходил проверку и стартовал: текст документов клиента уходил третьему получателю, НЕ
  // названному в п. 5.3 Политики, а метка в журнале и телеметрии продолжала утверждать «bitrixgpt».
  // Чтобы обойти гейт `custom`, не требовалось писать `custom`.
  //
  // В облаке подмена адреса запрещена ровно так же, как третий провайдер; в инсталляции клиента
  // (`SELF_HOSTED=1`) она законна — там провайдера выбирает клиент своим ключом (п. 12.3).
  if ((env.SELF_HOSTED ?? '') !== '1') {
    for (const key of ['DEEPSEEK_BASE_URL', 'BITRIXGPT_BASE_URL', 'LLM_BASE_URL'] as const) {
      if ((env[key] ?? '').trim()) {
        fatal.push(`${key} задан — в облаке адрес провайдера подменять нельзя (п. 5.3 Политики называет получателей поимённо). Это допустимо только в инсталляции клиента: поставьте SELF_HOSTED=1`)
      }
    }
  }

  // Отсутствующий ключ — НЕ фатально: приложение обязано подняться (установка, настройки, чат
  // работают), а каждый документ получит внятный отказ «ключ недействителен» через классификатор
  // отказов. Падать здесь значило бы менять понятную деградацию на непонятный рестарт-цикл.
  const provider = rawProvider || 'bitrixgpt'
  if (provider === 'bitrixgpt' && !(env.BITRIXGPT_API_KEY || env.VIBE_API_KEY)) {
    errors.push('LLM_PROVIDER=bitrixgpt, но ни BITRIXGPT_API_KEY, ни VIBE_API_KEY не заданы — распознавание будет отказывать')
  }
  if (provider === 'deepseek' && !env.DEEPSEEK_API_KEY) {
    errors.push('LLM_PROVIDER=deepseek, но DEEPSEEK_API_KEY не задан — распознавание будет отказывать')
  }

  return { errors, warnings, fatal }
}
