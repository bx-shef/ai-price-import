<script setup lang="ts">
import { computed } from 'vue'
import type { ImportJobView } from '~/composables/useImport'
import { jobStatusMeta, parseJobResult } from '~/utils/jobStatus'
import { jobProgress } from '~/utils/jobStages'

// One row in «Последние операции»: shows the file, a per-STAGE progress stepper while the job runs
// (Извлечение текста → Распознавание и запись → Готово, driven by the real backend status), and the
// outcome («разбор») once terminal. Pure presentation over the injected job — no I/O.
const props = defineProps<{ job: ImportJobView }>()

const meta = computed(() => jobStatusMeta(props.job.status))
const progress = computed(() => jobProgress(props.job.status))
const result = computed(() => parseJobResult(props.job.result))

const badgeColor: Record<string, 'air-primary' | 'air-primary-success' | 'air-primary-alert' | 'air-secondary'> = {
  neutral: 'air-secondary',
  info: 'air-primary',
  success: 'air-primary-success',
  danger: 'air-primary-alert'
}
// Progress-bar color follows the pipeline state.
const barColor = computed<'air-primary' | 'air-primary-success' | 'air-primary-alert'>(() =>
  progress.value.failed ? 'air-primary-alert' : progress.value.terminal ? 'air-primary-success' : 'air-primary')
// Per-step dot color token by state.
const stepDot: Record<string, string> = {
  done: 'bg-(--ui-color-accent-main-success)',
  active: 'bg-(--ui-color-accent-main-primary) animate-pulse',
  error: 'bg-(--ui-color-accent-main-alert)',
  pending: 'bg-(--ui-color-base-5)'
}
</script>

<template>
  <li class="flex flex-col gap-2 p-3">
    <div class="flex items-center justify-between gap-3">
      <p class="min-w-0 flex-1 truncate text-sm font-medium">
        {{ job.fileName || 'документ' }}
      </p>
      <B24Badge
        :label="meta.label"
        :color="badgeColor[meta.tone]"
        size="sm"
      />
    </div>

    <!-- IN-FLIGHT: per-stage stepper + progress bar so the user sees where the file is. -->
    <div
      v-if="!meta.terminal"
      class="flex flex-col gap-1.5"
    >
      <div class="flex items-center gap-1.5 text-xs">
        <template
          v-for="(s, i) in progress.steps"
          :key="s.key"
        >
          <span
            v-if="i > 0"
            class="h-px w-3 shrink-0 bg-(--ui-color-base-5)"
            aria-hidden="true"
          />
          <span
            class="inline-block h-2 w-2 shrink-0 rounded-full"
            :class="stepDot[s.state]"
          />
          <span :class="s.state === 'pending' ? 'text-(--ui-color-base-4)' : 'text-(--ui-color-base-2)'">
            {{ s.label }}
          </span>
        </template>
      </div>
      <B24Progress
        :model-value="progress.percent"
        size="xs"
        :color="barColor"
        :aria-label="`Стадия: ${progress.label}`"
      />
    </div>

    <!-- DONE: what was recognized/created («разбор»). -->
    <div
      v-else-if="!result.errors.length && !progress.failed"
      class="text-xs text-(--ui-color-base-3)"
    >
      <span v-if="result.entityId">Создано в CRM · сущность #{{ result.entityId }}</span>
      <span v-else-if="result.message">{{ result.message }}</span>
      <span v-else>Документ обработан</span>
      <ul
        v-if="result.warnings.length"
        class="mt-1 list-disc pl-4 text-(--ui-color-accent-main-warning)"
      >
        <li
          v-for="(w, i) in result.warnings"
          :key="i"
        >
          {{ w }}
        </li>
      </ul>
    </div>

    <!-- ERROR: the failure reason. -->
    <p
      v-else
      class="text-xs text-(--ui-color-accent-main-alert)"
    >
      {{ result.errors[0] || result.message || 'Не удалось обработать документ' }}
    </p>

    <!-- Отзыв 👍/👎 — только по завершённым, если канал включён на сервере. -->
    <FeedbackWidget
      v-if="meta.terminal"
      :job-id="job.jobId"
      :file-name="job.fileName"
    />
  </li>
</template>
