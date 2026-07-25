<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import { navigateTo } from '#app'
import { useMetrics } from '~/composables/useMetrics'
import { useB24 } from '~/composables/useB24'
import { APP_SLIDER_PLACE_METRICS } from '~/config/b24'
import { formatMinutes } from '~/utils/savings'
import { formatRate, summarizeMetrics } from '~/utils/metricsView'

// Detailed metrics page (P8 UI, second level). The motivating figures live on /app; this is the
// full per-portal breakdown: savings estimate + success rate + every counter with a label.
// Frame-token data via the SAME useMetrics composable (/api/import/metrics) — no extra endpoint.
// Presentation is the pure summarizeMetrics (successRate/labels/empty). Layout `clear`, prerendered.
definePageMeta({ layout: 'clear' })
useHead({ title: 'Метрики импорта' })

const { counters, savings, resetting, error, load, reset } = useMetrics()

// Opened as a B24 slider (openSliderAppPage({place:'metrics'})) or by in-frame navigation, so the
// «back» control closes the slider overlay vs navigates to /app. Standalone → plain navigation.
const { init: initB24, placementPlace, closeSlider } = useB24()
const isSlider = ref(false)
onMounted(async () => {
  try {
    await initB24()
    isSlider.value = placementPlace() === APP_SLIDER_PLACE_METRICS
  } catch { /* standalone */ }
  await load()
})
/** Slider → close the B24 overlay; in-frame/standalone → go back to /app. */
async function closeOrBack(): Promise<void> {
  if (isSlider.value) {
    await closeSlider()
    return
  }
  await navigateTo('/app')
}

const summary = computed(() => summarizeMetrics(counters.value))

// Two-step reset (no window.confirm), same pattern as /app.
const confirmReset = ref(false)
async function doReset(): Promise<void> {
  try {
    await reset()
  } finally {
    confirmReset.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-2xl p-4 sm:p-6">
    <div class="mb-4 flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold">
          Метрики импорта
        </h1>
        <p class="mt-1 text-sm text-(--ui-color-base-3)">
          Что приложение сделало для вашего портала.
        </p>
      </div>
      <button
        type="button"
        class="text-sm text-(--ui-color-accent-main-primary) hover:underline"
        @click="closeOrBack"
      >
        {{ isSlider ? 'Закрыть' : '← К обзору' }}
      </button>
    </div>

    <B24Alert
      v-if="error"
      class="mb-4"
      color="air-primary-warning"
      size="sm"
      :title="error"
    />

    <!-- Экономия (мотивирующая) -->
    <div class="grid grid-cols-2 gap-3">
      <div class="rounded-lg bg-(--ui-color-accent-soft-green-2) p-4">
        <div class="text-2xl font-semibold text-(--ui-color-accent-main-success)">
          {{ savings ? formatMinutes(savings.minutesSaved) : '—' }}
        </div>
        <div class="mt-1 text-xs text-(--ui-color-base-3)">
          Сэкономлено времени
        </div>
      </div>
      <div class="rounded-lg bg-(--ui-color-accent-soft-green-2) p-4">
        <div class="text-2xl font-semibold text-(--ui-color-accent-main-success)">
          {{ savings ? `${savings.moneySaved} ${savings.currency}` : '—' }}
        </div>
        <div class="mt-1 text-xs text-(--ui-color-base-3)">
          Сэкономлено денег (оценка)
        </div>
      </div>
    </div>

    <!-- Успешность -->
    <div class="mt-3 rounded-lg border border-(--ui-color-base-5) p-4">
      <div class="flex items-baseline justify-between">
        <span class="text-sm text-(--ui-color-base-3)">Успешно создано в CRM</span>
        <span class="text-lg font-semibold text-(--ui-color-base-1)">{{ formatRate(summary.successRate) }}</span>
      </div>
      <p class="mt-1 text-xs text-(--ui-color-base-4)">
        Доля обработанных документов, по которым создана сущность в CRM.
      </p>
    </div>

    <!-- Детальная разбивка -->
    <div class="mt-3 rounded-lg border border-(--ui-color-base-5)">
      <div class="border-b border-(--ui-color-base-5) px-4 py-2 text-xs font-semibold uppercase tracking-wide text-(--ui-color-base-4)">
        Счётчики
      </div>
      <p
        v-if="summary.empty"
        class="px-4 py-6 text-center text-sm text-(--ui-color-base-4)"
      >
        Пока нет данных — загрузите первый документ.
      </p>
      <ul
        v-else
        class="divide-y divide-(--ui-color-base-5)"
      >
        <li
          v-for="row in summary.rows"
          :key="row.key"
          class="flex items-center justify-between px-4 py-2.5 text-sm"
        >
          <span class="text-(--ui-color-base-3)">{{ row.label }}</span>
          <span class="font-semibold text-(--ui-color-base-1) tabular-nums">{{ row.value }}</span>
        </li>
      </ul>
    </div>

    <!-- Сброс -->
    <div class="mt-4 flex items-center gap-2">
      <B24Button
        :icon="RefreshIcon"
        color="air-tertiary-no-accent"
        size="sm"
        :label="'Обновить'"
        @click="load"
      />
      <div class="ml-auto flex items-center gap-2">
        <B24Button
          v-if="!confirmReset"
          label="Сбросить метрики"
          color="air-tertiary-no-accent"
          size="sm"
          @click="() => { confirmReset = true }"
        />
        <template v-else>
          <span class="text-sm text-(--ui-color-base-3)">Сбросить метрики?</span>
          <B24Button
            color="air-primary-alert"
            size="sm"
            :loading="resetting"
            :disabled="resetting"
            :label="resetting ? 'Сброс…' : 'Да'"
            @click="doReset"
          />
          <B24Button
            label="Отмена"
            color="air-tertiary-no-accent"
            size="sm"
            @click="() => { confirmReset = false }"
          />
        </template>
      </div>
    </div>

    <BuildFooter />
  </div>
</template>
