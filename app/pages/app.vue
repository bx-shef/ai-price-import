<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SettingsIcon from '@bitrix24/b24icons-vue/outline/SettingsIcon'
import CirclePlusIcon from '@bitrix24/b24icons-vue/outline/CirclePlusIcon'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import { useImport } from '~/composables/useImport'
import { useMetrics } from '~/composables/useMetrics'
import { useSettings } from '~/composables/useSettings'
import { isPortalConfigured } from '~/utils/portalSettings'
import { jobStatusMeta, parseJobResult } from '~/utils/jobStatus'
import { formatMinutes } from '~/utils/savings'

// In-portal home/dashboard (P8 UI slice): savings + status summary + recent operations.
// Reuses the /import + /metrics composables. Layout `clear`, prerendered. Styled with b24ui
// (B24Card + semantic --ui-color-* tokens) so it adapts to the portal's light/dark theme and the
// B24 mobile app — no raw Tailwind grays (which stay light-only).
definePageMeta({ layout: 'clear' })
useHead({ title: 'Импорт документов — обзор' })

const { jobs, loading, error, refresh } = useImport()
const { counters, savings, resetting, error: metricsError, load: loadMetrics, reset: resetMetrics } = useMetrics()

// Setup gate: the app works on defaults, but before the first import an admin should configure it
// (article field, target, chats). On load we read the portal settings; if nothing has been touched
// (pristine defaults) we nudge — an admin to open /settings, a non-admin to ask their admin. Only
// when settings actually loaded IN the portal (`settingsLoaded` — no frame → error → no nudge).
const { mapping, isAdmin, error: settingsError, load: loadSettings } = useSettings()
const settingsLoaded = ref(false)
const needsSetup = computed(() => settingsLoaded.value && !isPortalConfigured(mapping.value))

onMounted(async () => {
  refresh()
  loadMetrics()
  await loadSettings()
  // Loaded successfully inside the portal (a frame error means standalone/no-auth → don't nudge).
  settingsLoaded.value = !settingsError.value
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

// Stat-number colors via semantic accent tokens (theme-aware). done→success, running→primary,
// error→alert.
const tiles = computed(() => [
  { key: 'done', label: 'Обработано', value: stats.value.done, cls: 'text-(--ui-color-accent-main-success)' },
  { key: 'running', label: 'В работе', value: stats.value.running, cls: 'text-(--ui-color-accent-main-primary)' },
  { key: 'error', label: 'Ошибки', value: stats.value.error, cls: 'text-(--ui-color-accent-main-alert)' }
])

// Parse each job once (result JSON) instead of 3× per row in the template.
const rows = computed(() => jobs.value.map(job => ({
  job,
  meta: jobStatusMeta(job.status),
  result: parseJobResult(job.result)
})))

// Status tone → b24ui B24Badge air-color (theme-aware, replaces the raw bg/text map).
const badgeColor: Record<string, 'air-primary' | 'air-primary-success' | 'air-primary-alert' | 'air-secondary'> = {
  neutral: 'air-secondary',
  info: 'air-primary',
  success: 'air-primary-success',
  danger: 'air-primary-alert'
}
</script>

<template>
  <div class="mx-auto max-w-2xl p-4 sm:p-6">
    <div class="mb-5 flex items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">
          Импорт документов
        </h1>
        <p class="text-sm text-(--ui-color-base-3)">
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

    <!-- Setup nudge: shown until the admin configures the app (pristine defaults). Admin gets a
         call-to-action to /settings; a non-admin is told to ask their portal admin. -->
    <B24Alert
      v-if="needsSetup"
      class="mb-4"
      :color="isAdmin ? 'air-primary-warning' : 'air-primary-copilot'"
      :title="isAdmin ? 'Приложение не настроено' : 'Приложение ещё не настроено'"
      :description="isAdmin
        ? 'Задайте настройки импорта (поле артикула, целевую сущность, чаты уведомлений) перед первой загрузкой документа.'
        : 'Обратитесь к администратору портала — настройки импорта ещё не заданы.'"
    >
      <template
        v-if="isAdmin"
        #actions
      >
        <B24Button
          label="Настроить"
          to="/settings"
          color="air-primary"
          size="sm"
        />
      </template>
    </B24Alert>

    <div class="grid grid-cols-3 gap-3">
      <B24Card
        v-for="t in tiles"
        :key="t.key"
        variant="outline"
        class="text-center"
      >
        <div
          class="text-2xl font-semibold"
          :class="t.cls"
        >
          {{ t.value }}
        </div>
        <div class="mt-1 text-xs text-(--ui-color-base-3)">
          {{ t.label }}
        </div>
      </B24Card>
    </div>

    <!-- Экономия: сколько времени/денег сберёг импорт (оценка), + сброс метрик -->
    <B24Card
      variant="outline"
      class="mt-4"
    >
      <div class="mb-3 flex items-center justify-between gap-2">
        <h2 class="text-sm font-semibold">
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
            <span class="text-(--ui-color-base-3)">Сбросить метрики?</span>
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
        <B24Card
          variant="tinted-success"
          class="text-center"
        >
          <div class="text-2xl font-semibold text-(--ui-color-accent-main-success)">
            {{ savings ? formatMinutes(savings.minutesSaved) : '—' }}
          </div>
          <div class="mt-1 text-xs text-(--ui-color-base-3)">
            Сэкономлено времени
          </div>
        </B24Card>
        <B24Card
          variant="tinted-success"
          class="text-center"
        >
          <div class="text-2xl font-semibold text-(--ui-color-accent-main-success)">
            {{ savings ? `${savings.moneySaved} ${savings.currency}` : '—' }}
          </div>
          <div class="mt-1 text-xs text-(--ui-color-base-3)">
            Сэкономлено денег (оценка)
          </div>
        </B24Card>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-(--ui-color-base-3)">
        <span>Документов: {{ counters.docs || 0 }}</span>
        <span>Создано в CRM: {{ counters.created || 0 }}</span>
        <span>Позиций: {{ counters.lines || 0 }}</span>
        <NuxtLink
          to="/metrics"
          class="ml-auto text-(--ui-color-accent-main-link) hover:underline"
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
    </B24Card>

    <B24Alert
      v-if="error"
      class="mt-3"
      color="air-primary-warning"
      :title="error"
    />

    <div class="mt-6 mb-2 flex items-center justify-between">
      <h2 class="text-sm font-semibold">
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

    <B24Card
      variant="outline"
      :b24ui="{ body: 'p-0 sm:p-0' }"
    >
      <ul class="divide-y divide-(--ui-color-base-5)">
        <li
          v-if="!jobs.length"
          class="p-6 text-center text-sm text-(--ui-color-base-4)"
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
              class="truncate text-xs text-(--ui-color-accent-main-alert)"
            >
              {{ row.result.errors[0] }}
            </p>
            <p
              v-else-if="row.result.message"
              class="truncate text-xs text-(--ui-color-base-3)"
            >
              {{ row.result.message }}
            </p>
            <!-- Отзыв 👍/👎 — только по завершённым (done/error), если канал включён на сервере -->
            <FeedbackWidget
              v-if="row.job.status === 'done' || row.job.status === 'error'"
              :job-id="row.job.jobId"
              :file-name="row.job.fileName"
            />
          </div>
          <B24Badge
            :label="row.meta.label"
            :color="badgeColor[row.meta.tone]"
            size="sm"
          />
        </li>
      </ul>
    </B24Card>
  </div>
</template>
