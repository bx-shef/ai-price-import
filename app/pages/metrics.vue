<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import CrossMIcon from '@bitrix24/b24icons-vue/outline/CrossMIcon'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import { navigateTo } from '#app'
import { useMetrics } from '~/composables/useMetrics'
import { useB24 } from '~/composables/useB24'
import { APP_SLIDER_PLACE_METRICS } from '~/config/b24'
import { formatMinutes } from '~/utils/savings'
import { formatRate, summarizeMetrics } from '~/utils/metricsView'

// Detailed metrics page (P8 UI, second level). The motivating figures live on /app; this is the
// full per-portal breakdown: savings estimate + success rate + every counter with a label.
// Frame-token data via the SAME useMetrics composable (/api/import/metrics) — no extra endpoint.
// Presentation is the pure summarizeMetrics (successRate/labels/empty). Layout `clear`, prerendered.
definePageMeta({ layout: 'clear' })
useHead({ title: 'Метрики импорта', meta: [{ name: 'robots', content: 'noindex' }] }) // in-portal shell, see /app

const { counters, savings, resetting, error, load, reset } = useMetrics()

// Opened as a B24 slider (openSliderAppPage({place:'metrics'})) or by in-frame navigation, so the
// «back» control closes the slider overlay vs navigates to /app. Standalone → plain navigation.
const { init: initB24, placementPlace, closeSlider } = useB24()
const isSlider = ref(false)
onMounted(async () => {
  try {
    await initB24()
    isSlider.value = placementPlace() === APP_SLIDER_PLACE_METRICS
  } catch { /* standalone */ }
  await load()
})
/** Slider → close the B24 overlay; in-frame/standalone → go back to /app. */
async function closeOrBack(): Promise<void> {
  if (isSlider.value) {
    await closeSlider()
    return
  }
  await navigateTo('/app')
}

const summary = computed(() => summarizeMetrics(counters.value))

// Деньги показываем, только если админ портала задал стоимость часа (#270): валюту берём из самого
// портала и не выдумываем. Нет ставки — плитки нет, и сетка схлопывается в одну колонку, иначе
// одинокая плитка «Сэкономлено времени» висела бы на половине ширины с пустотой рядом.
const hasMoneyTile = computed(() => !!savings.value && savings.value.moneySaved !== null)
const moneySavedText = computed(() => (savings.value?.moneySaved ?? 0).toLocaleString('ru-RU'))

// Two-step reset (no window.confirm), same pattern as /app.
const confirmReset = ref(false)
async function doReset(): Promise<void> {
  try {
    await reset()
  } finally {
    confirmReset.value = false
  }
}
</script>

<template>
  <!-- CLIENT-ONLY: depends on the B24 frame handshake; prerender+hydrate framed mismatched (see /app). -->
  <ClientOnly>
    <div>
      <!-- Шапка — навбар каркаса (#259). Кнопка закрытия слайдера осталась той же: механику закрытия
           страница по-прежнему решает сама (closeOrBack), навбар несёт только хром. -->
      <B24DashboardNavbar
        :toggle="false"
        title="Метрики импорта"
      >
        <template #leading>
          <B24Button
            :icon="CrossMIcon"
            color="air-tertiary-no-accent"
            size="xs"
            :aria-label="isSlider ? 'Закрыть' : 'Вернуться к обзору'"
            @click="closeOrBack"
          />
        </template>
      </B24DashboardNavbar>

      <div class="mx-auto max-w-2xl p-4 pb-6 sm:p-6">
        <p class="mb-4 text-sm text-(--ui-color-base-3)">
          Сколько документов приложение обработало и сколько времени вам сэкономило.
        </p>
        <B24Alert
          v-if="error"
          class="mb-4"
          color="air-primary-warning"
          size="sm"
          :title="error"
        />

        <!-- Экономия — те же плитки B24PageCard, что на /app: два экрана одной фичи читаются одинаково. -->
        <B24PageGrid :class="hasMoneyTile ? 'sm:grid-cols-2 lg:grid-cols-2' : 'sm:grid-cols-1 lg:grid-cols-1'">
          <B24PageCard
            variant="tinted-no-accent"
            title="Сэкономлено времени"
            :b24ui="{ title: 'text-xs uppercase tracking-wide text-(--ui-color-base-3)' }"
          >
            <p class="text-[22px] leading-tight font-semibold">
              {{ savings ? formatMinutes(savings.minutesSaved) : '—' }}
            </p>
          </B24PageCard>
          <!-- Деньги — только при заданной стоимости часа (валюта портала, не константа; #270). -->
          <B24PageCard
            v-if="hasMoneyTile"
            variant="tinted-no-accent"
            title="Сэкономлено денег (примерно)"
            :b24ui="{ title: 'text-xs uppercase tracking-wide text-(--ui-color-base-3)' }"
          >
            <p class="text-[22px] leading-tight font-semibold">
              {{ moneySavedText }} <CurrencySign :code="savings?.currency ?? undefined" />
            </p>
          </B24PageCard>
        </B24PageGrid>

        <!-- Успешность -->
        <div class="mt-3 rounded-lg border border-(--ui-color-base-5) p-4">
          <div class="flex items-baseline justify-between">
            <span class="text-sm text-(--ui-color-base-3)">Документов дошло до CRM</span>
            <span class="text-lg font-semibold text-(--ui-color-base-1)">{{ formatRate(summary.successRate) }}</span>
          </div>
          <p class="mt-1 text-xs text-(--ui-color-base-4)">
            Из скольких загруженных документов получилась запись в CRM. Остальные — с ошибкой, их видно в списке операций.
          </p>
        </div>

        <!-- Детальная разбивка -->
        <div class="mt-3 rounded-lg border border-(--ui-color-base-5)">
          <div class="border-b border-(--ui-color-base-5) px-4 py-2 text-xs font-semibold uppercase tracking-wide text-(--ui-color-base-4)">
            Счётчики
          </div>
          <p
            v-if="summary.empty"
            class="px-4 py-6 text-center text-sm text-(--ui-color-base-4)"
          >
            Пока пусто. Загрузите первый документ на главной странице — счётчики появятся здесь.
          </p>
          <ul
            v-else
            class="divide-y divide-(--ui-color-base-5)"
          >
            <li
              v-for="row in summary.rows"
              :key="row.key"
              class="flex items-center justify-between px-4 py-2.5 text-sm"
            >
              <span class="text-(--ui-color-base-3)">{{ row.label }}</span>
              <span class="font-semibold text-(--ui-color-base-1) tabular-nums">{{ row.value }}</span>
            </li>
          </ul>
        </div>

        <!-- Сброс -->
        <div class="mt-4 flex items-center gap-2">
          <B24Button
            :icon="RefreshIcon"
            color="air-tertiary-no-accent"
            size="sm"
            :label="'Обновить'"
            @click="load"
          />
          <div class="ml-auto flex items-center gap-2">
            <B24Button
              v-if="!confirmReset"
              label="Обнулить счётчики"
              color="air-tertiary-no-accent"
              size="sm"
              @click="() => { confirmReset = true }"
            />
            <template v-else>
              <span class="text-sm text-(--ui-color-base-3)">Обнулить счётчики? Документы в CRM останутся.</span>
              <B24Button
                color="air-primary-alert"
                size="sm"
                :loading="resetting"
                :disabled="resetting"
                :label="resetting ? 'Сбрасываем…' : 'Да, обнулить'"
                @click="doReset"
              />
              <B24Button
                label="Отмена"
                color="air-tertiary-no-accent"
                size="sm"
                @click="() => { confirmReset = false }"
              />
            </template>
          </div>
        </div>

        <BuildFooter />
      </div>
    </div>
  </ClientOnly>
</template>
