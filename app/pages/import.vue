<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ChevronLeftMIcon from '@bitrix24/b24icons-vue/outline/ChevronLeftMIcon'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import { useImport } from '~/composables/useImport'
import { useCrmCategories } from '~/composables/useCrmCategories'
import * as catPicker from '~/utils/categoryPicker'
import type { CrmCategoryOption } from '~/utils/categoryPicker'
import type { TargetRef } from '~/types/mapping'
import { jobStatusMeta, parseJobResult } from '~/utils/jobStatus'

// In-portal document upload + status (P5 UI). Renders standalone; the pipeline runs
// only inside a Bitrix24 portal (frame auth). Layout `clear`, prerendered.
definePageMeta({ layout: 'clear' })
useHead({ title: 'Импорт документов' })

const { jobs, loading, uploading, error, refresh, upload } = useImport()

onMounted(refresh)

// Native B24FileUpload (multiple, built-in dropzone) → upload each picked file, then
// clear the model so the same file can be re-selected. Per-file status shows in the
// list below (fire-and-forget, matching the previous UX).
// Optional manual target («куда импортировать»): overrides the routing rules for the uploaded
// file(s). Default = «Авто» (null entity) → follow the portal's rules/default. Direction (воронка)
// is picked from the portal via the same helpers as settings. The server re-validates the target.
const { load: loadCrmCategories } = useCrmCategories()
const targetEtid = ref<number | null>(null)
const targetCategoryId = ref<number | undefined>(undefined)
const cats = ref<CrmCategoryOption[] | undefined>(undefined)
const TARGET_CHOICES: Array<{ id: number | null, label: string }> = [
  { id: null, label: 'Авто (по правилам)' },
  { id: 1, label: 'Лид' },
  { id: 2, label: 'Сделка' },
  { id: 31, label: 'Смарт-счёт' }
]
async function chooseTarget(id: number | null) {
  targetEtid.value = id
  targetCategoryId.value = undefined // entity switch → drop the direction
  cats.value = id ? await loadCrmCategories(id) : undefined
}
const catItems = computed(() => catPicker.categoryItems(cats.value))
const showDirection = computed(() => catPicker.hasCategories(cats.value))
const catValue = computed(() => (targetCategoryId.value == null ? '' : String(targetCategoryId.value)))
function onCategory(v: unknown) {
  const t: { categoryId?: number } = { categoryId: targetCategoryId.value }
  catPicker.setCategory(t, v)
  targetCategoryId.value = t.categoryId
}
function currentTarget(): TargetRef | null {
  if (!targetEtid.value) return null
  return { entityTypeId: targetEtid.value, ...(targetCategoryId.value != null ? { categoryId: targetCategoryId.value } : {}) }
}

const pending = ref<File[] | null>(null)
async function onPicked(files: File[] | null | undefined) {
  if (!files?.length) return
  const target = currentTarget()
  for (const f of files) await upload(f, target)
  pending.value = null
}

const toneClass: Record<string, string> = {
  neutral: 'bg-gray-100 text-gray-600',
  info: 'bg-blue-100 text-blue-700',
  success: 'bg-green-100 text-green-700',
  danger: 'bg-red-100 text-red-700'
}

// Parse each job's result once (not 3× per row in the template).
const rows = computed(() => jobs.value.map(job => ({
  job,
  meta: jobStatusMeta(job.status),
  result: parseJobResult(job.result)
})))
</script>

<template>
  <div class="mx-auto max-w-2xl p-4 sm:p-6">
    <div class="mb-3">
      <B24Button
        :icon="ChevronLeftMIcon"
        to="/app"
        label="К обзору"
        color="air-tertiary-no-accent"
        size="xs"
      />
    </div>
    <h1 class="mb-1 text-xl font-semibold">
      Импорт документов
    </h1>
    <p class="mb-5 text-sm text-gray-500">
      Загрузите накладную, счёт, КП или прайс — приложение найдёт контрагента и внесёт товары в CRM.
    </p>

    <div class="mb-4">
      <p class="mb-1 text-sm font-medium text-gray-700">
        Куда импортировать
      </p>
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
        <B24Select
          v-if="showDirection"
          :model-value="catValue"
          :items="catItems"
          class="w-52"
          aria-label="Направление (воронка)"
          @update:model-value="onCategory"
        />
      </div>
      <p class="mt-1 text-xs text-gray-400">
        По умолчанию — по правилам маршрутизации из настроек.
      </p>
    </div>

    <B24FileUpload
      v-model="pending"
      multiple
      accept=".pdf,.png,.jpg,.jpeg,.xlsx,.xls,.docx"
      :disabled="uploading"
      size="lg"
      label="Перетащите файл(ы) сюда или нажмите"
      description="PDF, изображения, Excel, Word · до 20 МБ"
      @update:model-value="onPicked"
    />

    <B24Alert
      v-if="error"
      class="mt-3"
      color="air-primary-warning"
      :title="error"
    />

    <div class="mt-6 mb-2 flex items-center justify-between">
      <h2 class="text-sm font-semibold text-gray-700">
        Последние загрузки
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
        class="p-4 text-center text-sm text-gray-400"
      >
        Пока нет загрузок
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
