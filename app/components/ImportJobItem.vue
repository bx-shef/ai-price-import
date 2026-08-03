<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import CrossMIcon from '@bitrix24/b24icons-vue/outline/CrossMIcon'
import type { ImportJobView } from '~/composables/useImport'
import { jobStatusMeta, parseJobResult, pluralRu } from '~/utils/jobStatus'
import { jobProgress } from '~/utils/jobStages'
import { entityDetailPath, entityTypeLabel } from '~/utils/entityLink'
import { isKnownTargetType, targetTypeName } from '~/utils/importFailure'
import { useB24 } from '~/composables/useB24'

// One row in «Последние операции»: shows the file, a per-STAGE progress stepper while the job runs
// (Извлечение текста → Распознавание и запись → Готово, driven by the real backend status), and the
// outcome («разбор») once terminal. Pure presentation over the injected job — no I/O.
const props = defineProps<{
  job: ImportJobView
  /** The File this page still holds for the job — the feedback widget attaches it itself (#349).
   *  Undefined after a reload: the server keeps no copy, so the widget then asks to pick it. */
  file?: File | null
}>()
// «Убрать из списка» — forgets just THIS row (page memory) in the parent; server keeps only ephemeral
// status, so this is purely the employee tidying their own history. Emitted with the jobId.
const emit = defineEmits<{ remove: [jobId: string] }>()

/** Сколько предупреждений печатать на СТРОКЕ С ОШИБКОЙ (#373). В ветке успеха их всё так же
 *  показываем целиком: там это редкие штучные замечания, а здесь — по одному на каждую позицию
 *  документа, и сотня строк растянула бы карточку задания на весь экран. */
const MAX_ERROR_WARNINGS = 5

const meta = computed(() => jobStatusMeta(props.job.status))
// «в Сделку» / «в Смарт-счёт» — только для РУЧНОГО выбора; когда цель определили правила, показывать
// нечего (и незачем: правило видно в настройках).
const targetLabel = computed(() => {
  const t = props.job.targetEntityTypeId
  // Только когда тип реально узнан: «в выбранную запись» — бессмысленный бейдж, лучше ничего.
  return t && isKnownTargetType(t) ? `в ${targetTypeName(t)}` : ''
})
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
// Step marker per state: filled + ✓ for a finished step, a ring for the current/upcoming one
// (matches the approved design — the stepper alone carries progress, there is no separate bar).
const stepDot: Record<string, string> = {
  done: 'bg-(--ui-color-accent-main-success) text-(--ui-color-base-8)',
  active: 'border-2 border-(--ui-color-accent-main-primary) animate-pulse',
  error: 'bg-(--ui-color-accent-main-alert) text-(--ui-color-base-8)',
  pending: 'border-2 border-(--ui-color-base-4)'
}
</script>

<template>
  <li class="flex flex-col gap-2.5 rounded-lg border border-(--ui-color-base-5) bg-(--ui-color-base-7) p-3.5">
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
      <div class="flex shrink-0 items-center gap-2">
        <!-- Куда файл направлялся, если цель выбирали вручную (#269). К моменту результата — тем более
             ошибки — сотрудник уже не помнит свой выбор, особенно при пакетной загрузке. -->
        <B24Badge
          v-if="targetLabel"
          :label="targetLabel"
          color="air-secondary"
          size="sm"
        />
        <B24Badge
          :label="meta.label"
          :color="badgeColor[meta.tone]"
          size="sm"
        />
        <!-- Убрать эту строку из «Последних операций» (только локальная история сотрудника). Пока задание
             в работе — не показываем (нельзя «потерять» строку активного импорта); доступно по завершении. -->
        <B24Button
          v-if="meta.terminal"
          :icon="CrossMIcon"
          color="air-tertiary-no-accent"
          size="xs"
          :aria-label="`Убрать из списка: ${job.fileName || 'документ'}`"
          @click="() => emit('remove', job.jobId)"
        />
      </div>
    </div>

    <!-- IN-FLIGHT: per-stage stepper so the user sees where the file is. -->
    <div
      v-if="!meta.terminal"
      class="flex flex-col gap-1.5"
    >
      <div
        class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs"
        :aria-label="`Стадия: ${progress.label}`"
        role="status"
      >
        <span
          v-for="s in progress.steps"
          :key="s.key"
          class="flex items-center gap-1.5"
        >
          <span
            class="flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] leading-none"
            :class="stepDot[s.state]"
            aria-hidden="true"
          >{{ s.state === 'done' ? '✓' : '' }}</span>
          <span :class="s.state === 'pending' ? 'text-(--ui-color-base-4)' : 'text-(--ui-color-base-2)'">
            {{ s.label }}
          </span>
        </span>
      </div>
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
        >Нажмите, чтобы открыть {{ entityTypeLabel(result.entityTypeId) }} №{{ result.entityId }} в CRM →</a>
        <span
          v-else-if="result.entityId"
          class="text-(--ui-color-accent-main-success)"
        >Создано в CRM: {{ entityTypeLabel(result.entityTypeId) }} №{{ result.entityId }}</span>
        <span v-else-if="result.message">{{ result.message }}</span>
        <span v-else>Документ обработан</span>
        <!-- «распознан» (not «привязан»): the name is what the AI read from the document — the company
             may or may not have matched in CRM (the unmatched warning below clarifies). -->
        <span
          v-if="result.supplier"
          class="min-w-0 break-words"
        >· поставщик из документа: {{ result.supplier }}</span>
        <!-- 0 lines on a created entity is notable (ничего не импортировалось) → surface as a warning. -->
        <span
          v-if="result.lines != null"
          :class="result.lines === 0 ? 'text-(--ui-color-accent-main-warning)' : ''"
        >· {{ result.lines }} {{ pluralRu(result.lines, ['позиция', 'позиции', 'позиций']) }}</span>
      </div>
      <div
        v-if="result.warnings.length"
        class="mt-1.5 flex flex-col gap-1 border-l-[3px] border-(--ui-color-accent-main-warning) pl-2.5"
      >
        <span
          v-for="(w, i) in result.warnings"
          :key="i"
          class="leading-relaxed text-(--ui-color-base-2)"
        >{{ w }}</span>
      </div>
      <!-- Совет — ОТДЕЛЬНО от списка проблем (#388): это подсказка, что делать дальше, а не дефект
           документа. В общем списке он раздувал счётчик и читался как ещё одна поломка. Цвет полосы
           тут не единственный признак: текст открывается словами «Что делать:» — на 3 px полосы
           роль не прочитать ни при цветовой слепоте, ни в чёрно-белом скриншоте.
           ⚠ В ветке ОШИБКИ такого блока нет и быть не может: ядро возвращает `errors` раньше, чем
           считает совет (валидации и отказ «пропущено всё» выходят до его вычисления), поэтому
           `advice` и `errors` взаимоисключающи по построению. Совет для этого случая уже несёт сам
           текст отказа. -->
      <p
        v-if="result.advice"
        class="mt-1.5 border-l-[3px] border-(--ui-color-accent-main-primary) pl-2.5 leading-relaxed text-(--ui-color-base-2)"
      >
        {{ result.advice }}
      </p>
    </div>

    <!-- ERROR: the failure reason. -->
    <div v-else>
      <p class="border-l-[3px] border-(--ui-color-accent-main-alert) pl-2.5 text-xs leading-relaxed text-(--ui-color-accent-main-alert)">
        {{ result.errors[0] || result.message || 'Не удалось обработать документ. Проверьте, что файл открывается и в нём есть таблица с товарами, затем загрузите его снова.' }}
      </p>
      <!-- #373: предупреждения показывались ТОЛЬКО в ветке успеха. На отказе «ни одна позиция не
           найдена» это ровно тот список, который человеку и нужен — названия товаров, которых нет
           в каталоге. Без него на экране остаётся общий приговор и ни одного названия. Кап — чтобы
           документ на сотню строк не превратил строку списка в простыню. -->
      <div
        v-if="result.warnings.length"
        class="mt-1.5 flex flex-col gap-1 border-l-[3px] border-(--ui-color-accent-main-warning) pl-2.5 text-xs"
      >
        <span
          v-for="(w, i) in result.warnings.slice(0, MAX_ERROR_WARNINGS)"
          :key="i"
          class="leading-relaxed text-(--ui-color-base-2)"
        >{{ w }}</span>
        <span
          v-if="result.warnings.length > MAX_ERROR_WARNINGS"
          class="text-(--ui-color-base-3)"
        >…и ещё {{ result.warnings.length - MAX_ERROR_WARNINGS }}</span>
      </div>
    </div>

    <!-- Отзыв 👍/👎 — только по завершённым, если канал включён на сервере. На строке с истёкшим
         статусом не спрашиваем: приложение уже не знает её результата, и отзыв уехал бы без контекста. -->
    <FeedbackWidget
      v-if="meta.terminal && job.status !== 'expired'"
      :job-id="job.jobId"
      :file-name="job.fileName"
      :file="file"
    />
  </li>
</template>
