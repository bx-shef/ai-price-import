<script setup lang="ts">
import { ref } from 'vue'

// Управление жизненным циклом «оцените приложение» руками, а не через SQL (вынесено из
// `pages/queues.vue` в #523).
//
// ⚠ Блок грузит своё состояние САМ и отдаёт наружу `reload()`; своя ошибка у него тоже своя (#271-E).
// ⚠ 401 уходит наверх событием: увести на вход — дело страницы.

const emit = defineEmits<{ unauthorized: [] }>()

type RatingState = 'reviewed' | 'opened' | 'prompted' | 'none'
interface RatingStatus { memberId: string, domain: string, state: RatingState, promptedAtMs: number | null, openedAtMs: number | null }

const ratings = ref<RatingStatus[]>([])
const ratingsError = ref('')

// «Оцените приложение» lifecycle per portal — the owner manages it here instead of running SQL.
const RATING_META: Record<RatingState, { label: string, cls: string }> = {
  opened: { label: 'открыл Маркет — проверьте отзыв', cls: 'text-(--ui-color-accent-main-warning)' },
  prompted: { label: 'показан, Маркет не открыл', cls: 'text-(--ui-color-base-3)' },
  none: { label: 'ещё не показывался', cls: 'text-(--ui-color-base-4)' },
  reviewed: { label: 'отзыв подтверждён', cls: 'text-(--ui-color-accent-main-success)' }
}
function fmtDate(ms: number | null): string {
  return ms ? new Date(ms).toLocaleDateString('ru-RU') : '—'
}

function isExpired(e: unknown): boolean {
  return (e as { statusCode?: number })?.statusCode === 401
}

// Токен последовательности: действие оператора и автоцикл могут наложиться, и ответ более СТАРОГО
// вызова записался бы поверх свежего.
let loadSeq = 0
async function load(): Promise<void> {
  const my = ++loadSeq
  try {
    const a = await $fetch<{ portals: RatingStatus[] }>('/api/ops/app-rating')
    if (my !== loadSeq) return
    ratings.value = a.portals
    ratingsError.value = ''
  } catch (e) {
    if (my !== loadSeq) return
    if (isExpired(e)) {
      emit('unauthorized')
      return
    }
    ratingsError.value = 'Не удалось получить оценки приложения'
  }
}

// Owner control of the review lifecycle from the UI (no SQL): confirm a review (terminal) or reset
// the flag so the modal shows again.
const ratingBusy = ref<string>('') // member_id currently mutating (disables ITS buttons only)
const { text: ratingMsg, flash: flashRating, clear: clearRatingMsg } = useFlashMessage()
// «Отзыв оставлен» — необратимо: состояние терминальное, кнопки сброса у него уже нет, откат только
// через SQL. Двухшаговое подтверждение у нас принятый паттерн на куда более безобидных действиях
// («Очистить список», «Обнулить счётчики») — здесь его не было (#271-I).
const confirmReviewed = ref<string>('')
const confirmUnreview = ref<string>('') // #318 п.2: отмена подтверждённого отзыва — тоже в два шага
async function setRating(memberId: string, action: 'reviewed' | 'reset' | 'unreview'): Promise<void> {
  ratingBusy.value = memberId
  clearRatingMsg() // иначе до ответа сервера висит исход ПРЕДЫДУЩЕЙ строки
  confirmReviewed.value = ''
  confirmUnreview.value = ''
  try {
    await $fetch('/api/ops/app-rating', { method: 'POST', body: { memberId, action } })
    flashRating(action === 'reviewed'
      ? 'Отмечено как «отзыв оставлен»'
      : action === 'unreview'
        ? 'Отметка снята. Чтобы попап показался снова, нажмите «Сбросить»'
        : 'Флаг сброшен — попап покажется снова')
    await load() // re-pull so the row reflects the new state
  } catch (e) {
    if (isExpired(e)) {
      emit('unauthorized')
      return
    }
    flashRating('Не удалось изменить статус')
  } finally {
    ratingBusy.value = ''
  }
}

/** Перечитать состояние оценок (зовёт страница: ручное «Обновить» и автоцикл). */
defineExpose({ reload: load })
</script>

<template>
  <div class="mt-8">
    <h2 class="mb-1 text-sm font-semibold text-(--ui-color-base-2)">
      Оценки приложения
    </h2>
    <B24Alert
      v-if="ratingsError"
      class="mb-2"
      color="air-primary-warning"
      size="sm"
      :title="ratingsError"
    />
    <p class="mb-3 text-xs text-(--ui-color-base-4)">
      После клика «Оценить» проверьте отзыв в Маркете и отметьте: «Отзыв оставлен» (попап больше не
      покажется) или «Сбросить» (покажется снова).
    </p>
    <p
      v-if="ratingMsg"
      class="mb-2 text-xs text-(--ui-color-base-3)"
      role="status"
    >
      {{ ratingMsg }}
    </p>
    <p
      v-if="!ratingsError && !ratings.length"
      class="mb-2 text-sm text-(--ui-color-base-4)"
    >
      Пока ни одному порталу попап не показывался.
    </p>
    <div class="space-y-2">
      <div
        v-for="r in ratings"
        :key="r.memberId"
        class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-(--ui-color-base-5) p-3"
      >
        <span class="flex flex-col">
          <span class="text-sm font-medium">{{ r.domain }}</span>
          <span class="text-xs text-(--ui-color-base-4)">
            показан: {{ fmtDate(r.promptedAtMs) }} · открыл: {{ fmtDate(r.openedAtMs) }}
          </span>
        </span>
        <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            class="text-sm"
            :class="RATING_META[r.state].cls"
          >{{ RATING_META[r.state].label }}</span>
          <!-- Подтверждение отзыва — в два шага (#271-I). Снять его теперь можно (#318 п.2), но
               это всё равно значимое действие: пока отметка стоит, попап портал не беспокоит. -->
          <B24Button
            v-if="r.state !== 'reviewed' && confirmReviewed !== r.memberId"
            color="air-tertiary-no-accent"
            size="xs"
            :loading="ratingBusy === r.memberId"
            :disabled="ratingBusy === r.memberId"
            label="Отзыв оставлен"
            :aria-label="`Отметить, что портал ${r.domain} оставил отзыв`"
            @click="() => { confirmReviewed = r.memberId }"
          />
          <span
            v-else-if="r.state !== 'reviewed'"
            class="flex flex-wrap items-center gap-2 text-xs"
          >
            <span class="text-(--ui-color-base-3)">Отметить окончательно? Отменить можно будет только через базу.</span>
            <B24Button
              color="air-primary-alert"
              size="xs"
              :loading="ratingBusy === r.memberId"
              :disabled="ratingBusy === r.memberId"
              label="Да, отзыв оставлен"
              @click="() => setRating(r.memberId, 'reviewed')"
            />
            <B24Button
              color="air-tertiary-no-accent"
              size="xs"
              label="Отмена"
              @click="() => { confirmReviewed = '' }"
            />
          </span>
          <B24Button
            v-if="r.state === 'opened' || r.state === 'prompted'"
            color="air-tertiary-no-accent"
            size="xs"
            :loading="ratingBusy === r.memberId"
            :disabled="ratingBusy === r.memberId"
            label="Сбросить"
            :aria-label="`Сбросить флаг оценки для портала ${r.domain}`"
            @click="() => setRating(r.memberId, 'reset')"
          />
          <!-- Отмена подтверждения (#318 п.2). Раньше «отзыв оставлен» был тупиком: ошибочный клик
               откатывался только через базу — а ошибаются здесь легко, строки идут подряд и кнопки
               рядом. Возврат — строго в состояние ДО подтверждения, ни шагом дальше: метки показов
               не трогаем. ⚠ Обычно это состояние «открывал Маркет», а оно молчит бессрочно, а не
               до конца срока, — поэтому после снятия отметки строке нужен ещё «Сбросить», и текст
               подсказки говорит это прямо. Два шага — как у остальных значимых действий. -->
          <B24Button
            v-if="r.state === 'reviewed' && confirmUnreview !== r.memberId"
            color="air-tertiary-no-accent"
            size="xs"
            :loading="ratingBusy === r.memberId"
            :disabled="ratingBusy === r.memberId"
            label="Снять отметку об отзыве"
            :aria-label="`Отменить отметку об отзыве для портала ${r.domain}`"
            @click="() => { confirmUnreview = r.memberId }"
          />
          <span
            v-else-if="r.state === 'reviewed'"
            class="flex flex-wrap items-center gap-2 text-xs"
          >
            <span class="text-(--ui-color-base-3)">Снять отметку об отзыве? Портал вернётся в состояние до подтверждения — чтобы попап показался снова, после этого нажмите «Сбросить».</span>
            <B24Button
              color="air-primary"
              size="xs"
              :loading="ratingBusy === r.memberId"
              :disabled="ratingBusy === r.memberId"
              label="Да, снять"
              @click="() => setRating(r.memberId, 'unreview')"
            />
            <B24Button
              color="air-tertiary-no-accent"
              size="xs"
              label="Отмена"
              @click="() => { confirmUnreview = '' }"
            />
          </span>
        </span>
      </div>
    </div>
  </div>
</template>
