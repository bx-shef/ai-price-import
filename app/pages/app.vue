<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import SettingsIcon from '@bitrix24/b24icons-vue/outline/SettingsIcon'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import ChevronDownMIcon from '@bitrix24/b24icons-vue/outline/ChevronDownMIcon'
import { useImport } from '~/composables/useImport'
import { useMetrics } from '~/composables/useMetrics'
import { useSettings } from '~/composables/useSettings'
import { useCrmCategories } from '~/composables/useCrmCategories'
import { useCrmStages } from '~/composables/useCrmStages'
import * as catPicker from '~/utils/categoryPicker'
import * as stagePicker from '~/utils/stagePicker'
import type { CrmCategoryOption } from '~/utils/categoryPicker'
import type { CrmStageOption } from '~/utils/stagePicker'
import type { TargetRef } from '~/types/mapping'
import { isPortalConfigured } from '~/utils/portalSettings'
import { formatMinutes } from '~/utils/savings'

// In-portal home — ACTION-FIRST (owner decision): the upload dropzone is the hero at the top so the
// primary flow (open → drop/snap a document) is one step, on desktop and in the B24 mobile app. The
// former separate /import page is merged here; recent operations + savings sit below. Layout `clear`,
// prerendered, styled with b24ui + semantic --ui-color-* tokens (light/dark-auto).
definePageMeta({ layout: 'clear' })
useHead({ title: 'Импорт документов' })

const { jobs, loading, uploading, error, hasActive, refresh, upload, startAutoPoll, stopAutoPoll } = useImport()
const { counters, savings, resetting, error: metricsError, load: loadMetrics, reset: resetMetrics } = useMetrics()

// Setup gate: the app works on defaults, but before the first import an admin should configure it
// (article field, target, chats). On load we read the portal settings; if nothing has been touched
// (pristine defaults) we nudge — an admin to open /settings, a non-admin to ask their admin. Only
// when settings actually loaded IN the portal (`settingsLoaded` — no frame → error → no nudge).
const { mapping, isAdmin, error: settingsError, load: loadSettings } = useSettings()
const settingsLoaded = ref(false)
const needsSetup = computed(() => settingsLoaded.value && !isPortalConfigured(mapping.value))

onMounted(async () => {
  startAutoPoll() // initial status load + follow in-flight jobs (self-stops when all terminal)
  loadMetrics()
  await loadSettings()
  // Loaded successfully inside the portal (a frame error means standalone/no-auth → don't nudge).
  settingsLoaded.value = !settingsError.value
})
onBeforeUnmount(stopAutoPoll) // don't keep polling after leaving the page

// ── Upload target («куда импортировать») — optional override of the portal's routing rules. Default
// «Авто» (null entity) → follow the rules/default. Direction + stage cascade from the portal (same
// helpers as settings). The server re-validates the target. Kept below the dropzone as an override. ──
const { load: loadCrmCategories } = useCrmCategories()
const { load: loadCrmStages } = useCrmStages()
const targetEtid = ref<number | null>(null)
const targetCategoryId = ref<number | undefined>(undefined)
const targetStageId = ref<string | undefined>(undefined)
const cats = ref<CrmCategoryOption[] | undefined>(undefined)
const stages = ref<CrmStageOption[] | undefined>(undefined)
const TARGET_CHOICES: Array<{ id: number | null, label: string }> = [
  { id: null, label: 'Авто (по правилам)' },
  { id: 1, label: 'Лид' },
  { id: 2, label: 'Сделка' },
  { id: 31, label: 'Смарт-счёт' }
]
async function reloadStages() {
  targetStageId.value = undefined // entity/direction change → drop the stage
  stages.value = targetEtid.value ? await loadCrmStages(targetEtid.value, targetCategoryId.value ?? null) : undefined
}
async function chooseTarget(id: number | null) {
  targetEtid.value = id
  targetCategoryId.value = undefined // entity switch → drop the direction
  // Clear the stage SYNCHRONOUSLY before the categories await, so a submit during that gap can't
  // send the previous entity's stageId with the new entity (reloadStages re-clears after the load).
  targetStageId.value = undefined
  stages.value = undefined
  cats.value = id ? await loadCrmCategories(id) : undefined
  await reloadStages()
}
const catItems = computed(() => catPicker.categoryItems(cats.value))
const showDirection = computed(() => catPicker.hasCategories(cats.value))
const catValue = computed(() => (targetCategoryId.value == null ? '' : String(targetCategoryId.value)))
async function onCategory(v: unknown) {
  const t: { categoryId?: number } = { categoryId: targetCategoryId.value }
  catPicker.setCategory(t, v)
  targetCategoryId.value = t.categoryId
  await reloadStages() // direction change → reload its stages
}
const stageItems = computed(() => stagePicker.stageItems(stages.value))
const showStage = computed(() => stagePicker.hasStages(stages.value))
const stageValue = computed(() => targetStageId.value ?? '')
function onStage(v: unknown) {
  const t: { stageId?: string } = { stageId: targetStageId.value }
  stagePicker.setStage(t, v)
  targetStageId.value = t.stageId
}
function currentTarget(): TargetRef | null {
  if (!targetEtid.value) return null
  return {
    entityTypeId: targetEtid.value,
    ...(targetCategoryId.value != null ? { categoryId: targetCategoryId.value } : {}),
    ...(targetStageId.value ? { stageId: targetStageId.value } : {})
  }
}

const pending = ref<File[] | null>(null)
async function onPicked(files: File[] | null | undefined) {
  if (!files?.length) return
  const target = currentTarget()
  for (const f of files) await upload(f, target)
  pending.value = null
}

// «Куда импортировать» is an advanced override — collapsed by default so the dropzone stays the hero.
const showTarget = ref(false)

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

// Compact status counts (inline in the «Последние операции» header instead of big dashboard tiles —
// keeps the upload above the fold).
const stats = computed(() => {
  const s = { done: 0, error: 0, running: 0 }
  for (const j of jobs.value) {
    if (j.status === 'done') s.done++
    else if (j.status === 'error') s.error++
    else s.running++
  }
  return s
})
</script>

<template>
  <div class="mx-auto max-w-2xl p-4 sm:p-6">
    <div class="mb-4 flex items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">
          Импорт документов
        </h1>
        <p class="text-sm text-(--ui-color-base-3)">
          Перетащите или сфотографируйте накладную, счёт, КП или прайс — товары уйдут в CRM.
        </p>
      </div>
      <B24Button
        :icon="SettingsIcon"
        to="/settings"
        color="air-tertiary-no-accent"
        size="sm"
        aria-label="Настройки импорта"
        class="shrink-0"
      />
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

    <!-- PRIMARY ACTION: upload dropzone (hero). Camera/files on mobile via the native input. -->
    <B24FileUpload
      v-model="pending"
      multiple
      accept=".pdf,.png,.jpg,.jpeg,.xlsx,.xls,.docx"
      :disabled="uploading"
      size="lg"
      label="Перетащите файл(ы) сюда или нажмите"
      description="PDF, фото, Excel, Word · до 20 МБ"
      @update:model-value="onPicked"
    />

    <!-- Optional target override, collapsed by default (default = portal routing rules). -->
    <div class="mt-2">
      <B24Button
        :icon="ChevronDownMIcon"
        :label="showTarget ? 'Скрыть выбор цели' : 'Куда импортировать? · по правилам'"
        color="air-tertiary-no-accent"
        size="xs"
        :aria-expanded="showTarget"
        @click="() => { showTarget = !showTarget }"
      />
      <div
        v-if="showTarget"
        class="mt-2"
        role="group"
        aria-label="Куда импортировать"
      >
        <div class="flex flex-wrap items-center gap-2">
          <B24Button
            v-for="c in TARGET_CHOICES"
            :key="String(c.id)"
            :label="c.label"
            size="sm"
            :color="targetEtid === c.id ? 'air-primary' : 'air-tertiary-no-accent'"
            :aria-pressed="targetEtid === c.id"
            @click="() => chooseTarget(c.id)"
          />
          <span class="text-xs text-(--ui-color-base-4)">или ID (смарт-процесс ≥ 1000):</span>
          <B24InputNumber
            :model-value="targetEtid"
            :min="1"
            class="w-24"
            aria-label="ID типа целевой сущности"
            @update:model-value="(v: unknown) => chooseTarget(typeof v === 'number' && v > 0 ? v : null)"
          />
          <B24Select
            v-if="showDirection"
            :model-value="catValue"
            :items="catItems"
            class="w-full sm:w-52"
            aria-label="Направление (воронка)"
            @update:model-value="onCategory"
          />
          <B24Select
            v-if="showStage"
            :model-value="stageValue"
            :items="stageItems"
            class="w-full sm:w-48"
            aria-label="Стадия"
            @update:model-value="onStage"
          />
        </div>
      </div>
    </div>

    <B24Alert
      v-if="error"
      class="mt-3"
      color="air-primary-warning"
      :title="error"
    />

    <!-- STATUS: recent operations with compact inline counts. -->
    <div class="mt-6 mb-2 flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 class="text-sm font-semibold">
          Последние операции
        </h2>
        <span
          v-if="jobs.length"
          class="flex items-center gap-2 text-xs"
        >
          <span class="text-(--ui-color-accent-main-success)">готово: {{ stats.done }}</span>
          <span class="text-(--ui-color-accent-main-primary)">в работе: {{ stats.running }}</span>
          <span class="text-(--ui-color-accent-main-alert)">ошибки: {{ stats.error }}</span>
        </span>
        <span
          v-if="hasActive"
          class="flex items-center gap-1 text-xs text-(--ui-color-accent-main-primary)"
          role="status"
        >
          <span class="inline-block size-1.5 animate-pulse rounded-full bg-(--ui-color-accent-main-primary)" />
          обновляется
        </span>
      </div>
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
        <!-- Immediate feedback while the POST is in flight, before the job row appears. -->
        <li
          v-if="uploading"
          class="flex items-center gap-2 p-3 text-sm text-(--ui-color-base-3)"
        >
          <span class="inline-block size-2 shrink-0 animate-pulse rounded-full bg-(--ui-color-accent-main-primary)" />
          Загружаем файл…
        </li>
        <li
          v-if="!jobs.length && !uploading"
          class="p-6 text-center text-sm text-(--ui-color-base-4)"
        >
          Пока нет загрузок — перетащите или сфотографируйте документ выше.
        </li>
        <ImportJobItem
          v-for="job in jobs"
          :key="job.jobId"
          :job="job"
        />
      </ul>
    </B24Card>

    <!-- Экономия (компактно, внизу): сколько времени/денег сберёг импорт (оценка), + сброс метрик -->
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

    <!-- Маркетинг: self-hosted оффер «развернём на вашем сервере» (внизу, ненавязчиво). -->
    <SelfHostedPromo />
  </div>
</template>
