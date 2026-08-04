import { checkBackendEnv } from '../utils/envCheck'

// Validate env on boot: log errors/warnings; CRASH on a fatal misconfiguration (no-op at prerender).
//
// ⚠ Раньше плагин не ронял процесс НИКОГДА, и это по-прежнему верно для ошибок и предупреждений:
// они означают деградацию, а поднявшийся сервис с деградацией лучше рестарт-цикла — оператор хотя
// бы видит `/queues` и журнал. Исключение ровно одно и заведено #416: конфигурация, при которой
// поднявшийся сервис ВРЁТ опубликованному документу (неизвестный `LLM_PROVIDER` молча уходит в
// дефолт; `custom` в облаке — третий, неназванный получатель текста документов против п. 5.3
// Политики). Там останов — единственный исход, при котором опубликованный текст остаётся верным.
export default defineNitroPlugin(() => {
  if (import.meta.prerender) return
  const { errors, warnings, fatal } = checkBackendEnv(process.env)
  for (const w of warnings) console.warn('[env] warning:', w)
  for (const e of errors) console.error('[env] ERROR:', e)
  if (fatal.length) {
    for (const f of fatal) console.error('[env] FATAL:', f)
    // Бросаем, а не `process.exit`: Nitro напечатает причину, а оркестратор увидит незапустившийся
    // контейнер. Тихий выход с нулевым кодом читался бы как штатное завершение.
    throw new Error(`[env] сервис не запущен: ${fatal.join('; ')}`)
  }
})
