<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useImport } from '~/composables/useImport'
import { jobStatusMeta, parseJobResult } from '~/utils/jobStatus'

// In-portal home/dashboard (P8 UI slice): status summary + recent operations.
// Reuses the /import composable/API. Layout `clear`, prerendered.
definePageMeta({ layout: 'clear' })
useHead({ title: 'Импорт документов — обзор' })

const { jobs, loading, error, refresh } = useImport()
onMounted(refresh)

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
        <NuxtLink
          to="/settings"
          class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50"
          aria-label="Настройки импорта"
        >
          <svg
            class="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <circle
              cx="12"
              cy="12"
              r="3"
            />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span class="hidden sm:inline">Настройки</span>
        </NuxtLink>
        <NuxtLink
          to="/import"
          class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          Загрузить документ
        </NuxtLink>
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

    <p
      v-if="error"
      class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700"
    >
      {{ error }}
    </p>

    <div class="mt-6 mb-2 flex items-center justify-between">
      <h2 class="text-sm font-semibold text-gray-700">
        Последние операции
      </h2>
      <button
        type="button"
        class="text-xs text-blue-600 hover:underline disabled:opacity-50"
        :disabled="loading"
        @click="refresh"
      >
        {{ loading ? 'Обновление…' : 'Обновить' }}
      </button>
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
