<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { CONSENT_TEXT } from '~/config/cookieConsent'
import { isConsentPath } from '~/utils/cookieConsent'
import { SHELL_BG_HEX, SHELL_VARS } from '~/config/landingShell'
import { useCookieConsent } from '~/composables/useCookieConsent'

// Уведомление о cookie (#404). Полоса снизу на публичных страницах, до ответа посетителя.
//
// ⚠ Оболочка берётся из общего источника (`config/landingShell`), а не пишется здесь заново: у
// публичных страниц почти чёрный фон, и полоса с цветом текста «по умолчанию» была бы нечитаемой —
// ровно так уже сгорели /eula и /privacy (#368).
//
// ⚠ Полоса СНИЗУ, а не поверх первого экрана: на телефоне баннер сверху закрывает заголовок и
// кнопку призыва, то есть сайт встречает посетителя закрытым содержимым.

const route = useRoute()
const { choice, ready, load, decide } = useCookieConsent()

// Читаем хранилище только в браузере: на пререндере его нет, а решение о показе, принятое на
// сервере, вмёрзло бы в статический HTML для всех сразу.
onMounted(load)

const visible = computed(() => ready.value && choice.value === null && isConsentPath(route.path))

// На странице Политики ссылка вела бы туда, где посетитель уже находится.
const showPolicyLink = computed(() => route.path.toLowerCase() !== CONSENT_TEXT.policyPath)

// ⚠ Полоса `fixed`, потока не занимает — и накрывает последние строки страницы НАВСЕГДА: на
// юридических документах под ней оказывалась строка реквизитов издателя, и доскроллить её было
// нельзя, страница уже кончилась. Поэтому пока баннер виден, низ страницы получает отступ ровно в
// его высоту. Высота меряется, а не задаётся числом: она зависит от переносов текста и системного
// размера шрифта (на 375 px это две строки, на десктопе — одна).
const bar = useTemplateRef<HTMLElement>('bar')
let observer: ResizeObserver | undefined

function applyPadding() {
  if (typeof document === 'undefined') return
  document.body.style.paddingBottom = visible.value && bar.value ? `${bar.value.offsetHeight}px` : ''
}

watch(visible, async (on) => {
  await nextTick()
  applyPadding()
  observer?.disconnect()
  if (on && bar.value && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(applyPadding)
    observer.observe(bar.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  if (typeof document !== 'undefined') document.body.style.paddingBottom = ''
})
</script>

<template>
  <!-- `ClientOnly` не нужен: до `onMounted` `ready` ложно, поэтому на сервере и на гидратации
       рендерится одно и то же — ничего. -->
  <div
    v-if="visible"
    ref="bar"
    class="cookie-banner"
    :style="{ ...SHELL_VARS, '--cookie-bg': SHELL_BG_HEX }"
    role="region"
    aria-label="Уведомление о файлах cookie"
  >
    <p class="cookie-text">
      {{ CONSENT_TEXT.message }}
      <NuxtLink
        v-if="showPolicyLink"
        :to="CONSENT_TEXT.policyPath"
        class="cookie-link"
      >{{ CONSENT_TEXT.policy }}</NuxtLink>
    </p>
    <div class="cookie-actions">
      <!-- Два равноправных ответа. Кнопки «только необходимые» нет — значит отказ выражается
           закрытием вкладки, то есть выбора нет вовсе, а вопрос задан. -->
      <button
        type="button"
        class="cookie-btn cookie-btn-ghost"
        @click="decide('declined')"
      >
        {{ CONSENT_TEXT.decline }}
      </button>
      <button
        type="button"
        class="cookie-btn cookie-btn-primary"
        @click="decide('accepted')"
      >
        {{ CONSENT_TEXT.accept }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.cookie-banner {
  position: fixed;
  inset-inline: 0;
  bottom: 0;
  z-index: 60;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.6rem 1.25rem;
  padding: 0.7rem 1rem calc(0.7rem + env(safe-area-inset-bottom));
  /* Непрозрачный: при 0.97 сквозь полосу читались строки документа под ней — на контраст это не
     влияло, но выглядело как грязь. Значение — из общего источника оболочки (#368), а не второй
     рукописной копией хекса. */
  background: var(--cookie-bg);
  border-top: 1px solid var(--legal-border);
  color: var(--legal-text);
  font-size: 0.875rem;
  line-height: 1.45;
}
.cookie-text { max-width: 60ch; margin: 0; }
.cookie-link { color: var(--legal-link); text-decoration: underline; }
/* Кольцо фокуса было написано только для кнопок, и ссылка получала браузерный дефолт — тёмно-серую
   рамку 1 px на почти чёрном фоне, то есть невидимую. */
.cookie-link:focus-visible { outline: 2px solid var(--legal-link); outline-offset: 2px; }
.cookie-actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
.cookie-btn {
  border-radius: 0.5rem;
  padding: 0.45rem 1rem;
  font-weight: 500;
  cursor: pointer;
  /* Планка касания 44×44 (WCAG 2.5.8): на телефоне кнопки стоят рядом, и промах по соседней —
     это выбор, которого посетитель не делал. */
  min-height: 44px;
}
.cookie-btn-primary { background: var(--legal-link); color: var(--cookie-bg); border: 1px solid transparent; }
.cookie-btn-ghost { background: transparent; color: var(--legal-text); border: 1px solid var(--legal-border); }
.cookie-btn:focus-visible { outline: 2px solid var(--legal-link); outline-offset: 2px; }
</style>
