<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import LikeIcon from '@bitrix24/b24icons-vue/main/LikeIcon'
import { useAppRating } from '~/composables/useAppRating'

// Reusable in-portal «оцените приложение» modal. Drop it on any in-portal page and drive it with a
// `trigger` that flips true at a moment the user has clearly seen the app's value (e.g. after a
// successful import). The SHOW decision, throttle and manual-verification logic all live server-side
// (portal_app_rating) — this component only reacts to it. See docs/PROJECT_MAP.md §«Попап оценки».
//
// Flow: trigger → check() (GET /api/app-rating) → if show, render + stamp prompted_at (throttles the
// next prompt for RATING_REPROMPT_DAYS) → «Оценить» opens the Market detail page (stamps opened_at)
// or «Не сейчас» hides it. Inert outside a portal / when b24MarketCode is unset.
const props = defineProps<{
  /** Flip to true once the user has clearly benefited (a completed import). Triggers the check. */
  trigger?: boolean
}>()

const { show, check, markPrompted, openMarket, dismiss } = useAppRating()

// Don't interrupt: wait ~10s AFTER the successful import before asking, so the employee actually SEES
// the result (entity link / recognized items) first — otherwise the modal covers the fresh result and
// opening the Market rating navigates away before it's read. The delay also naturally covers the
// «after a short idle» case. check() self-guards (fires once; server decides whether to show).
const PROMPT_DELAY_MS = 10_000
let timer: ReturnType<typeof setTimeout> | null = null
function clearTimer(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
watch(
  () => props.trigger,
  (on) => {
    if (on && !timer && !show.value) {
      timer = setTimeout(() => {
        timer = null
        void check()
      }, PROMPT_DELAY_MS)
    }
  },
  { immediate: true }
)
onBeforeUnmount(clearTimer)

// The moment the modal actually shows, stamp prompted_at so it won't reappear for the interval —
// even if the user just closes it. (markPrompted is fire-and-forget.)
watch(show, (isOpen) => {
  if (isOpen) markPrompted()
})

// B24Modal is controllable via v-model:open; closing via overlay/escape/close-button routes here.
function onOpenChange(open: boolean): void {
  if (!open) dismiss()
}
</script>

<template>
  <B24Modal
    :open="show"
    title="Нравится приложение?"
    description="Оцените нас в Маркете — это помогает развивать продукт и занимает минуту."
    :unmount-on-hide="true"
    @update:open="onOpenChange"
  >
    <template #body>
      <div class="flex flex-col items-center gap-4 text-center">
        <!-- Подсказка «где ставится оценка» (#380). Первая запись была снята с показа: на ролике
             стояла карточка ЧУЖОГО приложения — чужие логотип и название. Нынешняя анимация —
             СИНТЕТИЧЕСКАЯ, собранная из НАШИХ материалов (решение владельца 2026-08-04): логотип —
             те же байты, что иконка приложения, название и издатель настоящие. Генерирует ручной
             `pnpm rating-demo` (scripts/make-rating-demo.mjs); правка логотипа/названия требует
             перегенерации. Ленивая загрузка — картинка нужна только открывшим модалку. -->
        <img
          src="/app-rating-demo.gif"
          alt="Анимация: на карточке приложения в Маркете курсор ставит пятую звезду оценки"
          width="320"
          height="204"
          loading="lazy"
          class="rounded-lg border border-(--ui-color-divider-default)"
        >
        <p class="text-sm text-(--ui-color-base-3)">
          Кнопка откроет карточку приложения в Маркете поверх портала — оценка ставится там.
          Честная оценка, даже критичная, очень помогает нам.
        </p>
      </div>
    </template>

    <template #footer="{ close }">
      <div class="flex w-full flex-wrap justify-end gap-2">
        <B24Button
          label="Не сейчас"
          color="air-tertiary-no-accent"
          @click="close"
        />
        <B24Button
          :icon="LikeIcon"
          label="Оценить"
          color="air-primary"
          @click="openMarket"
        />
      </div>
    </template>
  </B24Modal>
</template>
