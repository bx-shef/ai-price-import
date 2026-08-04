import { ref } from 'vue'
import { CONSENT_KEY } from '~/config/cookieConsent'
import { analyticsAllowed, parseConsent, serializeConsent, type ConsentChoice } from '~/utils/cookieConsent'

// Решение посетителя о cookie (#404). Синглтон: баннер один на приложение, а спросить о состоянии
// может кто угодно.

const choice = ref<ConsentChoice>(null)
/** Прочитали ли хранилище. До этого баннер не показываем — иначе он мигнёт у того, кто уже ответил. */
const ready = ref(false)

export function useCookieConsent() {
  const load = () => {
    if (ready.value) return
    // ⚠ `localStorage` бросает в приватном режиме части браузеров. Непрочитанное решение читается
    // как «не отвечал»: баннер покажется снова, аналитика не запустится — сторона ошибки выбрана.
    try {
      choice.value = parseConsent(window.localStorage.getItem(CONSENT_KEY))
    } catch {
      choice.value = null
    }
    ready.value = true
  }

  const decide = (value: Exclude<ConsentChoice, null>) => {
    choice.value = value
    try {
      window.localStorage.setItem(CONSENT_KEY, serializeConsent(value))
    } catch { /* не сохранилось — спросим в следующий раз, это не повод ломать страницу */ }
    // ⚠ Счётчик поднимается ЗДЕСЬ, без перезагрузки: иначе согласие вступало бы в силу только со
    // следующего захода, и первый — самый ценный для рекламы — визит терялся бы целиком.
    // Функцию объявляет инлайн-сниппет (nuxt.config); её отсутствие означает, что счётчик не
    // настроен вовсе, и это не ошибка.
    if (analyticsAllowed(value)) {
      const start = (window as unknown as { __ymStart?: () => void }).__ymStart
      if (typeof start === 'function') start()
    }
  }

  return { choice, ready, load, decide }
}
