<script setup lang="ts">
import { buildB24FormSrc } from '~/utils/b24Form'
import { B24_FORM_FALLBACK, firstFilled } from '~/config/runtimeDefaults'

// Embedded Bitrix24 CRM web-form. The form itself lives in a dedicated
// same-origin document (`/public/b24-form.html`) served with a form-scoped CSP;
// here we only build the iframe `src` from public config and relay the submit
// event to Metrika. Empty config ⇒ a placeholder slot (owner sets the env vars).
const config = useRuntimeConfig()

const src = computed(() => buildB24FormSrc(
  // ⚠ Пустое значение читается как «не задано» и уступает умолчанию (#305). Прямо `config.public.*`
  // брать нельзя: `docker compose` материализует строку `KEY=` как ЗАДАННОЕ пустое значение, оно
  // перебивает умолчание в рантайме, и лендинг остаётся без формы заявки — молча, у того, кто просто
  // скопировал `.env.example` в `.env`. Умолчания в `nuxt.config.ts` этого не ловят: там `||`
  // читается на СБОРКЕ, а перебивает переменная на ЗАПУСКЕ.
  firstFilled(config.public.b24FormScriptUrl, B24_FORM_FALLBACK.scriptUrl),
  firstFilled(config.public.b24FormId, B24_FORM_FALLBACK.id),
  firstFilled(config.public.b24FormSecret, B24_FORM_FALLBACK.secret)
))

// b24:form:submit is relayed from the iframe document via postMessage. The
// iframe (/b24-form.html) is same-origin, so reject any other origin — otherwise
// an unrelated frame could spoof the `brief_submit` analytics goal.
function onFrameMessage(e: MessageEvent) {
  if (e.origin !== window.location.origin) return
  if (e.data !== 'b24:form:submit') return
  const id = Number(config.public.metrikaId)
  if (!id) return
  const w = window as Window & { ym?: (...args: unknown[]) => void }
  w.ym?.(id, 'reachGoal', 'brief_submit')
}

onMounted(() => window.addEventListener('message', onFrameMessage))
onUnmounted(() => window.removeEventListener('message', onFrameMessage))
</script>

<template>
  <div class="overflow-hidden rounded-2xl border border-white/10 bg-black/30 backdrop-blur-sm">
    <iframe
      v-if="src"
      :src="src"
      class="min-h-[760px] w-full border-0 rounded-2xl sm:min-h-[620px]"
      title="Форма заявки на установку"
      loading="lazy"
    />

    <div
      v-else
      class="flex min-h-[280px] items-center justify-center p-6 text-center"
    >
      <p class="text-sm text-white/50">
        Слот под CRM-форму Bitrix24 — задайте переменные
        <code class="font-mono">NUXT_PUBLIC_B24_FORM_*</code>, чтобы встроить форму.
      </p>
    </div>
  </div>
</template>
