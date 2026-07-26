<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ImportJobView } from '~/composables/useImport'
import { jobStatusMeta, parseJobResult, pluralRu } from '~/utils/jobStatus'
import { jobProgress } from '~/utils/jobStages'
import { entityDetailPath } from '~/utils/entityLink'
import { useB24 } from '~/composables/useB24'

// One row in «Последние операции»: shows the file, a per-STAGE progress stepper while the job runs
// (Извлечение текста → Распознавание и запись → Готово, driven by the real backend status), and the
// outcome («разбор») once terminal. Pure presentation over the injected job — no I/O.
const props = defineProps<{ job: ImportJobView }>()

const meta = computed(() => jobStatusMeta(props.job.status))
const progress = computed(() => jobProgress(props.job.status))
const result = computed(() => parseJobResult(props.job.result))

// Link to the created CRM entity, opened in a portal slider via the frame SDK (slider.openPath — the
// CORRECT use of openPath: a real PORTAL path). Only offered IN a portal frame (`inFrame`): a CRM link
// is meaningless standalone, and the frame is needed to resolve/open it — so outside a frame we render
// the plain «Создано в CRM» text instead of a dead button. Null path (no/invalid entity) → no link.
const { init: initB24, get: getFrame, auth: frameAuth, inFrame } = useB24()
const entityPath = computed(() => entityDetailPath(result.value.entityTypeId, result.value.entityId))
const canOpen = computed(() => !!entityPath.value && inFrame())
// Real absolute portal URL so the result row shows a COPYABLE link (href), while the click still opens
// the entity in a portal slider (@click.prevent → openEntity). `frameReady` re-evaluates the href once
// the (singleton) frame handshake resolves — frameAuth() is not reactive on its own.
const frameReady = ref(false)
onMounted(async () => {
  await initB24()
  frameReady.value = true
})
const entityHref = computed<string | undefined>(() => {
  void frameReady.value
  const path = entityPath.value
  if (!path) return undefined
  const domain = (frameAuth()?.domain ?? '').replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  return domain ? `https://${domain}${path}` : undefined
})
async function openEntity(): Promise<void> {
  const path = entityPath.value
  if (!path) return
  await initB24()
  const frame = getFrame()
  if (frame) {
    try {
      await frame.slider.openPath(frame.slider.getUrl(path))
      return
    } catch { /* framed but the slider call threw → fall back to a plain new-tab open */ }
  }
  // Fallback only reaches here framed (canOpen gated on inFrame), so the domain is available. The frame
  // may report the domain WITH a scheme ("https://portal…") — strip it, else the URL doubles the scheme.
  const domain = (frameAuth()?.domain ?? '').replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (domain && typeof window !== 'undefined') window.open(`https://${domain}${path}`, '_blank', 'noopener')
}

// The archived SOURCE file on the Disk (opt-in `saveFile`): make the file name open it, mirroring the
// entity link. `diskUrl` is a same-portal RELATIVE path from the server (never off-portal); shown as a
// link only in a portal frame (where the slider/domain are available).
// Show the file-name link whenever the file was archived and we're in a frame (mirrors `canOpen` for
// the entity link — the click opens a slider even if the absolute href can't be built yet).
const canOpenDisk = computed(() => {
  void frameReady.value
  return !!props.job.diskUrl && inFrame()
})
const diskHref = computed<string | undefined>(() => {
  void frameReady.value
  const rel = props.job.diskUrl
  if (!rel) return undefined
  const domain = (frameAuth()?.domain ?? '').replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  return domain ? `https://${domain}${rel}` : undefined
})
async function openDiskFile(): Promise<void> {
  const rel = props.job.diskUrl
  if (!rel) return
  await initB24()
  const frame = getFrame()
  if (frame) {
    try {
      await frame.slider.openPath(frame.slider.getUrl(rel))
      return
    } catch { /* framed but the slider call threw → fall back to a plain new-tab open */ }
  }
  const domain = (frameAuth()?.domain ?? '').replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (domain && typeof window !== 'undefined') window.open(`https://${domain}${rel}`, '_blank', 'noopener')
}

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
      <!-- When the source file was archived to the Disk, the file name links to it (opens in a slider);
           otherwise it's plain text. -->
      <a
        v-if="canOpenDisk"
        :href="diskHref"
        class="min-w-0 flex-1 truncate text-sm font-medium text-(--ui-color-accent-main-link) hover:underline"
        :title="`Открыть исходный файл: ${job.fileName}`"
        @click.prevent="openDiskFile"
      >
        {{ job.fileName || 'документ' }}
      </a>
      <p
        v-else
        class="min-w-0 flex-1 truncate text-sm font-medium"
      >
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
      <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <!-- Real portal URL (copyable) in href; click opens the entity in a portal slider (prevent
             default so we don't also navigate the tab). -->
        <a
          v-if="result.entityId && canOpen"
          :href="entityHref"
          class="font-medium text-(--ui-color-accent-main-success) hover:underline"
          @click.prevent="openEntity"
        >Открыть в CRM · сущность #{{ result.entityId }} →</a>
        <span
          v-else-if="result.entityId"
          class="text-(--ui-color-accent-main-success)"
        >Создано в CRM · сущность #{{ result.entityId }}</span>
        <span v-else-if="result.message">{{ result.message }}</span>
        <span v-else>Документ обработан</span>
        <!-- «распознан» (not «привязан»): the name is what the AI read from the document — the company
             may or may not have matched in CRM (the unmatched warning below clarifies). -->
        <span
          v-if="result.supplier"
          class="min-w-0 break-words"
        >· распознан поставщик: {{ result.supplier }}</span>
        <!-- 0 lines on a created entity is notable (ничего не импортировалось) → surface as a warning. -->
        <span
          v-if="result.lines != null"
          :class="result.lines === 0 ? 'text-(--ui-color-accent-main-warning)' : ''"
        >· {{ result.lines }} {{ pluralRu(result.lines, ['позиция', 'позиции', 'позиций']) }}</span>
      </div>
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
