<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ChevronLeftMIcon from '@bitrix24/b24icons-vue/outline/ChevronLeftMIcon'
import CirclePlusIcon from '@bitrix24/b24icons-vue/outline/CirclePlusIcon'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import { useImport } from '~/composables/useImport'
import { jobStatusMeta, parseJobResult } from '~/utils/jobStatus'

// In-portal document upload + status (P5 UI). Renders standalone; the pipeline runs
// only inside a Bitrix24 portal (frame auth). Layout `clear`, prerendered.
definePageMeta({ layout: 'clear' })
useHead({ title: 'Импорт документов' })

const { jobs, loading, uploading, error, refresh, upload } = useImport()
const fileInput = ref<HTMLInputElement | null>(null)
const dragOver = ref(false)

onMounted(refresh)

async function onFiles(files: FileList | null) {
  if (!files || !files.length) return
  for (const f of Array.from(files)) await upload(f)
  if (fileInput.value) fileInput.value.value = ''
}
function onDrop(e: DragEvent) {
  dragOver.value = false
  void onFiles(e.dataTransfer?.files ?? null)
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

    <div
      class="rounded-xl border-2 border-dashed p-8 text-center transition-colors"
      :class="dragOver ? 'border-blue-400 bg-blue-50' : 'border-gray-300'"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
    >
      <p class="mb-3 text-sm text-gray-600">
        Перетащите файл(ы) сюда или
      </p>
      <B24Button
        :icon="CirclePlusIcon"
        color="air-primary"
        :loading="uploading"
        :disabled="uploading"
        :label="uploading ? 'Загрузка…' : 'Выбрать файл'"
        @click="fileInput?.click()"
      />
      <input
        ref="fileInput"
        type="file"
        multiple
        class="hidden"
        accept=".pdf,.png,.jpg,.jpeg,.xlsx,.xls,.docx"
        @change="onFiles(($event.target as HTMLInputElement).files)"
      >
      <p class="mt-3 text-xs text-gray-400">
        PDF, изображения, Excel, Word · до 20 МБ
      </p>
    </div>

    <B24Alert
      v-if="error"
      class="mt-3"
      color="air-primary-warning"
      variant="soft"
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
