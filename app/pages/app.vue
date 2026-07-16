<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SettingsIcon from '@bitrix24/b24icons-vue/outline/SettingsIcon'
import CirclePlusIcon from '@bitrix24/b24icons-vue/outline/CirclePlusIcon'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import { useImport } from '~/composables/useImport'
import { useMetrics } from '~/composables/useMetrics'
import { jobStatusMeta, parseJobResult } from '~/utils/jobStatus'
import { formatMinutes } from '~/utils/savings'

// In-portal home/dashboard (P8 UI slice): savings + status summary + recent operations.
// Reuses the /import + /metrics composables. Layout `clear`, prerendered.
definePageMeta({ layout: 'clear' })
useHead({ title: 'Импорт документов — обзор' })

const { jobs, loading, error, refresh } = useImport()
const { counters, savings, resetting, error: metricsError, load: loadMetrics, reset: resetMetrics } = useMetrics()
onMounted(() => {
  refresh()
  loadMetrics()
})

// Two-step reset (no window.confirm): click «Сбросить» → confirm inline. Keep the
// confirm visible (so «Да» shows «Сброс…»/disabled) until the request resolves.
const confirmReset = ref(false)
async function doReset(): Promise<void> {
  try {
    await resetMetrics()
  } finally {
    confirmReset.value = false
  }
}

const stats = computed(() => {
  const s = { total: jobs.value.length, done: 0, error: 0, running: 0 }
  for (const j of jobs.value) {
    if (j.status === 'done') s.done++
    else if (j.status === 'error') s.error++
    else s.running++
  }
  return s
})

const tiles = computed(() => [
  { key: 'done', label: 'Обработано', value: stats.value.done, cls: 'text-green-600' },
  { key: 'running', label: 'В работе', value: stats.value.running, cls: 'text-blue-600' },
  { key: 'error', label: 'Ошибки', value: stats.value.error, cls: 'text-red-600' }
])

// Parse each job once (result JSON) instead of 3× per row in the template.
const rows = computed(() => jobs.value.map(job => ({
  job,
  meta: jobStatusMeta(job.status),
  result: parseJobResult(job.result)
})))

const toneClass: Record<string, string> = {
  neutral: 'bg-gray-100 text-gray-600',
  info: 'bg-blue-100 text-blue-700',
  success: 'bg-green-100 text-green-700',
  danger: 'bg-red-100 text-red-700'
}
</script>

<template>
  <div class="mx-auto max-w-2xl p-4 sm:p-6">
    <div class="mb-5 flex items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">
          Импорт документов
        </h1>
        <p class="text-sm text-gray-500">
          Товары из накладных, счетов и КП — сразу в CRM.
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <B24Button
          :icon="SettingsIcon"
          to="/settings"
          color="air-tertiary-no-accent"
          size="sm"
          aria-label="Настройки импорта"
        />
        <B24Button
          :icon="CirclePlusIcon"
          to="/import"
          color="air-primary"
          size="sm"
          label="Загрузить документ"
        />
      </div>
    </div>

    <div class="grid grid-cols-3 gap-3">
      <div
        v-for="t in tiles"
        :key="t.key"
        class="rounded-xl border border-gray-200 p-4 text-center"
      >
        <div
          class="text-2xl font-semibold"
          :class="t.cls"
        >
          {{ t.value }}
        </div>
        <div class="mt-1 text-xs text-gray-500">
          {{ t.label }}
        </div>
      </div>
    </div>

    <!-- Экономия: сколько времени/денег сберёг импорт (оценка), + сброс метрик -->
    <div class="mt-4 rounded-xl border border-gray-200 p-4">
      <div class="mb-3 flex items-center justify-between gap-2">
        <h2 class="text-sm font-semibold text-gray-700">
          Экономия
        </h2>
        <div class="flex items-center gap-2 text-xs">
          <B24Button
            v-if="!confirmReset"
            label="Сбросить"
            color="air-tertiary-no-accent"
            size="xs"
            @click="() => { confirmReset = true }"
          />
          <template v-else>
            <span class="text-gray-600">Сбросить метрики?</span>
            <B24Button
              color="air-primary-alert"
              size="xs"
              :loading="resetting"
              :disabled="resetting"
              :label="resetting ? 'Сброс…' : 'Да'"
              @click="doReset"
            />
            <B24Button
              label="Отмена"
              color="air-tertiary-no-accent"
              size="xs"
              @click="() => { confirmReset = false }"
            />
          </template>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="rounded-lg bg-green-50 p-3">
          <div class="text-2xl font-semibold text-green-700">
            {{ savings ? formatMinutes(savings.minutesSaved) : '—' }}
          </div>
          <div class="mt-1 text-xs text-gray-500">
            Сэкономлено времени
          </div>
        </div>
        <div class="rounded-lg bg-green-50 p-3">
          <div class="text-2xl font-semibold text-green-700">
            {{ savings ? `${savings.moneySaved} ${savings.currency}` : '—' }}
          </div>
          <div class="mt-1 text-xs text-gray-500">
            Сэкономлено денег (оценка)
          </div>
        </div>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
        <span>Документов: {{ counters.docs || 0 }}</span>
        <span>Создано в CRM: {{ counters.created || 0 }}</span>
        <span>Позиций: {{ counters.lines || 0 }}</span>
        <NuxtLink
          to="/metrics"
          class="ml-auto text-blue-600 hover:underline"
        >
          Подробные метрики →
        </NuxtLink>
      </div>
      <B24Alert
        v-if="metricsError"
        class="mt-3"
        color="air-primary-warning"
        size="sm"
        :title="metricsError"
      />
    </div>

    <B24Alert
      v-if="error"
      class="mt-3"
      color="air-primary-warning"
      :title="error"
    />

    <div class="mt-6 mb-2 flex items-center justify-between">
      <h2 class="text-sm font-semibold text-gray-700">
        Последние операции
      </h2>
      <B24Button
        :icon="RefreshIcon"
        color="air-tertiary-no-accent"
        size="xs"
        :loading="loading"
        :disabled="loading"
        :label="loading ? 'Обновление…' : 'Обновить'"
        @click="refresh"
      />
    </div>

    <ul class="divide-y rounded-lg border border-gray-200">
      <li
        v-if="!jobs.length"
        class="p-6 text-center text-sm text-gray-400"
      >
        Пока нет загрузок — нажмите «Загрузить документ».
      </li>
      <li
        v-for="row in rows"
        :key="row.job.jobId"
        class="flex items-center justify-between gap-3 p-3"
      >
        <div class="min-w-0">
          <p class="truncate text-sm font-medium">
            {{ row.job.fileName || 'документ' }}
          </p>
          <p
            v-if="row.result.errors.length"
            class="truncate text-xs text-red-500"
          >
            {{ row.result.errors[0] }}
          </p>
          <p
            v-else-if="row.result.message"
            class="truncate text-xs text-gray-500"
          >
            {{ row.result.message }}
          </p>
          <!-- Отзыв 👍/👎 — только по завершённым (done/error), если канал включён на сервере -->
          <FeedbackWidget v-if="row.job.status === 'done' || row.job.status === 'error'" />
        </div>
        <span
          class="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium"
          :class="toneClass[row.meta.tone]"
        >
          {{ row.meta.label }}
        </span>
      </li>
    </ul>
  </div>
</template>
