<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import SettingsIcon from '@bitrix24/b24icons-vue/outline/SettingsIcon'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import { navigateTo } from '#app'
import { useImport } from '~/composables/useImport'
import { useMetrics } from '~/composables/useMetrics'
import { useSettings } from '~/composables/useSettings'
import { useSettingsSync } from '~/composables/useSettingsSync'
import { useB24 } from '~/composables/useB24'
import { APP_SLIDER_PLACE_SETTINGS, APP_SLIDER_PLACE_METRICS } from '~/config/b24'
import { isPortalConfigured } from '~/utils/portalSettings'
import { formatMinutes } from '~/utils/savings'

// In-portal home — ACTION-FIRST (owner decision): the upload dropzone is the hero at the top so the
// primary flow (open → drop/snap a document) is one step, on desktop and in the B24 mobile app. The
// former separate /import page is merged here; recent operations + savings sit below. Layout `clear`,
// prerendered, styled with b24ui + semantic --ui-color-* tokens (light/dark-auto).
definePageMeta({ layout: 'clear' })
useHead({ title: 'AI-импорт прайсов' })

const { jobs, loading, uploading, error, hasActive, refresh, upload, startAutoPoll, stopAutoPoll, clearHistory } = useImport()
// Two-step clear (no window.confirm), same pattern as the metrics reset.
const confirmClear = ref(false)
function doClearHistory(): void {
  clearHistory()
  confirmClear.value = false
}
const { counters, savings, resetting, error: metricsError, load: loadMetrics, reset: resetMetrics } = useMetrics()

// Setup gate: the app works on defaults, but before the first import an admin should configure it
// (article field, target, chats). On load we read the portal settings; if nothing has been touched
// (pristine defaults) we nudge — an admin to open /settings, a non-admin to ask their admin. Only
// when settings actually loaded IN the portal (`settingsLoaded` — no frame → error → no nudge).
const { mapping, isAdmin, error: settingsError, load: loadSettings } = useSettings()
const settingsLoaded = ref(false)
const needsSetup = computed(() => settingsLoaded.value && !isPortalConfigured(mapping.value))

// Open settings in a B24 SLIDER (native overlay), like the official b24-ai-starter reference:
// `openSliderAppPage({ place })` re-opens THIS app in a slider carrying `place='app-options'`, and the
// global middleware routes that slider frame to /settings. We do NOT use `slider.openPath` — that opens
// a PORTAL-relative path (it resolved to `<portal>/settings` → 404). Fallback to in-frame navigation
// when not framed (standalone) or if the SDK call fails, so settings always opens.
const { openAppSlider } = useB24()
async function openSettings(): Promise<void> {
  const opened = await openAppSlider(APP_SLIDER_PLACE_SETTINGS, { width: 900, title: 'Настройки импорта' })
  if (!opened) await navigateTo('/settings')
}
// Detailed metrics — same slider pattern as settings (openSliderAppPage → middleware routes to /metrics).
async function openMetrics(): Promise<void> {
  const opened = await openAppSlider(APP_SLIDER_PLACE_METRICS, { width: 900, title: 'Метрики импорта' })
  if (!opened) await navigateTo('/metrics')
}

// Live settings sync (starter pull `reload.options`): when settings are saved in the slider (or another
// open instance), re-read them so the setup nudge reflects the new config immediately. Subscribe
// SYNCHRONOUSLY in setup — after an `await` the active effect scope is lost and onScopeDispose (inside
// the composable) would no-op, leaking the pull client. init() runs async inside; this is inert
// outside a portal.
const { subscribeReload } = useSettingsSync()
subscribeReload(() => void loadSettings())

onMounted(async () => {
  startAutoPoll() // initial status load + follow in-flight jobs (self-stops when all terminal)
  loadMetrics()
  await loadSettings()
  // Loaded successfully inside the portal (a frame error means standalone/no-auth → don't nudge).
  settingsLoaded.value = !settingsError.value
})
onBeforeUnmount(stopAutoPoll) // don't keep polling after leaving the page

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

// Trigger the «оцените приложение» modal only after a FRESH successful import THIS session — a job we
// watched go from active → done. NOT a lifetime metric (counters.created) nor the initial history count
// (both would arm on mere page-open for a returning user, and the modal would pop with no new result to
// read). `seenActive` remembers jobIds observed non-terminal; a done job that was in it = a fresh
// completion. The show/throttle/verification decision is server-side (portal_app_rating); the modal
// delays ~10s after this flips so the result is seen first. See docs/redesign/12.
const TERMINAL_STATUSES = new Set(['done', 'error'])
const seenActive = new Set<string>()
const freshImportSuccess = ref(false)
watch(jobs, (list) => {
  for (const j of list) {
    if (!TERMINAL_STATUSES.has(j.status)) seenActive.add(j.jobId)
    else if (j.status === 'done' && seenActive.has(j.jobId)) freshImportSuccess.value = true
  }
}, { deep: true })
</script>

<template>
  <!-- CLIENT-ONLY: this in-portal page's content depends on the B24 frame handshake (auth/placement),
       which exists only in the browser — server-prerendering it and hydrating framed produced
       "Hydration completed but contains mismatches" (and, when a slider opened /app then the middleware
       redirected, the prerendered /app header fused with the redirected page's body). ClientOnly renders
       nothing on the server → no mismatch. -->
  <ClientOnly>
    <div class="mx-auto max-w-2xl p-4 sm:p-6">
      <div class="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 class="text-xl font-semibold">
            AI-импорт прайсов
          </h1>
          <p class="text-sm text-(--ui-color-base-3)">
            Перетащите или сфотографируйте накладную, счёт, КП или прайс — товары уйдут в CRM.
          </p>
        </div>
        <B24Button
          :icon="SettingsIcon"
          color="air-tertiary-no-accent"
          size="sm"
          aria-label="Настройки импорта"
          class="shrink-0"
          @click="openSettings"
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
            color="air-primary"
            size="sm"
            @click="openSettings"
          />
        </template>
      </B24Alert>

      <!-- PRIMARY ACTION: stage files → set a per-file target → import one-by-one on «Импортировать».
           `upload` comes from THIS page's single useImport() so uploads land in the same job list/poll. -->
      <ImportStaging :upload="upload" />

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
        <div class="flex items-center gap-2">
          <template v-if="jobs.length && !confirmClear">
            <B24Button
              label="Очистить историю"
              color="air-tertiary-no-accent"
              size="xs"
              @click="() => { confirmClear = true }"
            />
          </template>
          <template v-else-if="confirmClear">
            <span class="text-xs text-(--ui-color-base-3)">Очистить историю импортов?</span>
            <B24Button
              label="Да"
              color="air-primary-alert"
              size="xs"
              @click="doClearHistory"
            />
            <B24Button
              label="Отмена"
              color="air-tertiary-no-accent"
              size="xs"
              @click="() => { confirmClear = false }"
            />
          </template>
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
          <button
            type="button"
            class="ml-auto text-(--ui-color-accent-main-link) hover:underline"
            @click="openMetrics"
          >
            Подробные метрики →
          </button>
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

      <!-- «Оцените приложение»: всплывает после успешного импорта (когда польза очевидна). Показ/
         троттлинг/верификация — на сервере (portal_app_rating). Инертен вне портала. -->
      <AppRatingModal :trigger="freshImportSuccess" />

      <BuildFooter />
    </div>
  </ClientOnly>
</template>
