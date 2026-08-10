<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import CrossMIcon from '@bitrix24/b24icons-vue/outline/CrossMIcon'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import HelpIcon from '@bitrix24/b24icons-vue/main/HelpIcon'
import { navigateTo } from '#app'
import { useMetrics } from '~/composables/useMetrics'
import { useB24 } from '~/composables/useB24'
import { APP_SLIDER_PLACE_METRICS } from '~/config/b24'
import { formatMinutes } from '~/utils/savings'
import { formatRate, summarizeMetrics } from '~/utils/metricsView'
import { PORTAL_CONTENT_X, PORTAL_NAVBAR_CLASS } from '~/config/portalShell'

// Detailed metrics page (P8 UI, second level). The motivating figures live on /app; this is the
// full per-portal breakdown: savings estimate + success rate + every counter with a label.
// Frame-token data via the SAME useMetrics composable (/api/import/metrics) — no extra endpoint.
// Presentation is the pure summarizeMetrics (successRate/labels/empty). Layout `clear`, prerendered.
definePageMeta({ layout: 'clear' })
useHead({ title: 'Метрики импорта', meta: [{ name: 'robots', content: 'noindex' }] }) // in-portal shell, see /app

const { counters, savings, loaded, resetting, error, loadError, load, reset } = useMetrics()

// Opened as a B24 slider (openSliderAppPage({place:'metrics'})) or by in-frame navigation, so the
// «back» control closes the slider overlay vs navigates to /app. Standalone → plain navigation.
const { init: initB24, placementPlace, closeSlider, isAdmin, inFrame } = useB24()
const isSlider = ref(false)
/**
 * Мы во фрейме портала? `null` — ЕЩЁ НЕ ЗНАЕМ (#408).
 *
 * ⚠ Три состояния, а не два. Со стартовым `false` условие «вне портала — сразу готово» срабатывало
 * на первом же клиентском рендере, до того как завершилось рукопожатие с порталом: экран успевал
 * отрисовать нули — ровно тот дефект, который чинится, просто короче. Неизвестно — значит грузим.
 */
const inPortal = ref<boolean | null>(null)

// Обнуление счётчиков — только администратору (#411). Признак берём из фрейма (`IS_ADMIN` приезжает
// вместе с токеном), сервер ради этого не расширяем.
//
// ⚠ Прежде кнопку видел КАЖДЫЙ: рядовой сотрудник проходил двухшаговое подтверждение «Да, обнулить»
// и только после согласия получал 403. Интерфейс предлагал то, чего не разрешает, и говорил об этом
// после того, как человек согласился, — хуже и чем спрятать, и чем показать заблокированным.
//
// ⚠ Скрытие — удобство. Настоящая проверка осталась на сервере (403), см. `useB24().isAdmin`.
const admin = ref(false)
onMounted(async () => {
  try {
    await initB24()
    isSlider.value = placementPlace() === APP_SLIDER_PLACE_METRICS
    admin.value = isAdmin()
    inPortal.value = inFrame()
  } catch { /* standalone → остаётся false: вне портала сброс не показываем никому */ }
  await load()
})

/**
 * «Обновить» перечитывает и признак администратора.
 *
 * ⚠ `init()` при сбое рукопожатия не бросает, а возвращает `null` — тогда `catch` выше не
 * срабатывает, `admin` молча остаётся `false`, и АДМИНИСТРАТОР не видит кнопку до перезагрузки
 * страницы, причём без единого объяснения на экране. Одноразового присваивания мало, а «Обновить»
 * — естественная вторая попытка, и она уже на экране.
 */
async function reload(): Promise<void> {
  try {
    await initB24()
    admin.value = isAdmin()
  } catch { /* остаёмся с прежним значением */ }
  await load()
}
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
    <!-- Панель каркаса (#259): навбар — в #header, контент — в #body. `:b24ui` МЕРДЖИТСЯ
         (tailwind-merge), не заменяет базу — `min-h-svh`/прокрутка/паддинг тела сняты явными
         конфликтующими классами `min-h-0`/`overflow-y-visible`/`gap-0`/`sm:p-0` (см. /app). -->
    <B24DashboardPanel
      id="metrics"
      :b24ui="{ root: 'relative flex flex-col w-full min-w-0 min-h-0', body: 'flex flex-col gap-0 overflow-y-visible sm:p-0' }"
    >
      <template #header>
        <!-- Шапка — навбар каркаса (#259). Кнопка закрытия слайдера осталась той же: механику
             закрытия страница по-прежнему решает сама (closeOrBack), навбар несёт только хром. -->
        <!-- ⚠ Отступы навбара выровнены с колонкой контента (`px-4 sm:px-6`): родные `ps-2 lg:ps-4`
             ставили заголовок левее карточек, и на широком экране шапка читалась отдельно от
             страницы. Та же правка, что на `/app` (10.08.2026). -->
        <B24DashboardNavbar
          :toggle="false"
          title="Метрики импорта"
          :b24ui="{ root: PORTAL_NAVBAR_CLASS }"
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
      </template>

      <template #body>
        <!-- ⚠ Колонка НЕ капается по ширине (10.08.2026, та же правка, что на `/app`). В слайдере
             720 ничего не изменилось: 720 − 48 отступов = ровно те же 672 px, из которых ширина
             слайдера и выведена. Изменилось поведение НА ШИРОКОМ окне — раньше там оставался узкий
             столбик посередине с заголовком где-то слева от него. -->
        <div :class="[PORTAL_CONTENT_X, 'w-full py-4 pb-6 sm:py-6']">
          <p class="mb-4 text-sm text-(--ui-color-base-3)">
            Сколько документов приложение обработало и сколько времени вам сэкономило.
          </p>
          <!-- ⚠ Всё содержимое под состоянием загрузки (#408). Прежде плитки рисовались сразу, и
               пока данные шли, счётчики были нулевые: человек читал «0 документов» как факт о своём
               портале, а при нулях срабатывала ещё и ветка пустого состояния — портал, где импорт
               шёл месяцами, на долю секунды сообщал, что импортов не было.
               `inert` — вне портала: там фрейм-токена нет, загрузка не начнётся никогда, и без
               этого человек остался бы наедине с вечным скелетоном. -->
          <ScreenState
            :loaded="loaded"
            :error="loadError"
            :inert="inPortal === false"
          >
            <template #skeleton>
              <MetricsLoader />
            </template>

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

            <!-- Успешность — карточка шаблона, а не ручной div.border (#259): один визуальный язык со
             всеми блоками страницы. -->
            <B24PageCard
              variant="outline"
              class="mt-3"
            >
              <div class="flex items-baseline justify-between">
                <span class="text-sm text-(--ui-color-base-3)">Документов дошло до CRM</span>
                <span class="text-lg font-semibold text-(--ui-color-base-1)">{{ formatRate(summary.successRate) }}</span>
              </div>
              <p class="mt-1 text-xs text-(--ui-color-base-4)">
                Из скольких загруженных документов получилась запись в CRM. Остальные — с ошибкой, их видно в списке операций.
              </p>
            </B24PageCard>

            <!-- Детальная разбивка — пара «тонированная шапка + тело», как блоки настроек (#259 §1.3). -->
            <div class="mt-3">
              <B24PageCard
                variant="tinted"
                title="Счётчики"
                :b24ui="{ root: 'rounded-none sm:rounded-t-3xl' }"
              />
              <B24PageCard
                variant="outline"
                :b24ui="{ root: 'rounded-none border-t-0 sm:rounded-b-3xl' }"
              >
                <p
                  v-if="summary.empty"
                  class="py-2 text-center text-sm text-(--ui-color-base-4)"
                >
                  Пока пусто. Загрузите первый документ на главной странице — счётчики появятся здесь.
                </p>
                <ul
                  v-else
                  class="divide-y divide-(--ui-color-divider-default)"
                >
                  <li
                    v-for="row in summary.rows"
                    :key="row.key"
                    class="flex items-center justify-between py-2.5 text-sm"
                  >
                    <span class="text-(--ui-color-base-3)">{{ row.label }}</span>
                    <span class="font-semibold text-(--ui-color-base-1) tabular-nums">{{ row.value }}</span>
                  </li>
                </ul>
              </B24PageCard>
            </div>
          </ScreenState>

          <!-- ⚠ Ошибки, НЕ связанные с загрузкой (сброс счётчиков), — здесь: об отказе загрузки
               говорит `ScreenState` выше, а отказ сброса иначе не показывался бы нигде вовсе. -->
          <B24Alert
            v-if="error && !loadError"
            class="mt-4"
            color="air-primary-warning"
            size="sm"
            :title="error"
          />

          <!-- Сброс — ВНЕ состояния загрузки: «Обновить» это способ повторить попытку, и он обязан
               быть доступен как раз тогда, когда данные не пришли. -->
          <div class="mt-4 flex items-center gap-2">
            <B24Button
              :icon="RefreshIcon"
              color="air-tertiary-no-accent"
              size="sm"
              :label="'Обновить'"
              @click="reload"
            />
            <div class="ml-auto flex items-center gap-2">
              <!-- Не-админу: на месте кнопки подсказка, КТО может обнулить, а не «недостаточно
                   прав» — второе не подсказывает следующего шага. На телефоне тултипа нет вовсе
                   (решение владельца): наведения там нет, а тултип-по-нажатию это отдельный
                   паттерн со своими правилами закрытия. Следствие принято осознанно — на телефоне
                   не-админ видит просто отсутствие действия, и отсутствующее действие не требует
                   оправдания. -->
              <B24Tooltip
                v-if="!admin"
                :delay-duration="100"
                :content="{ side: 'left' }"
                text="Обнулить счётчики может администратор портала — попросите его."
                class="hidden sm:inline-flex"
                :b24ui="{ content: 'max-w-xs' }"
              >
                <!-- ⚠ Носитель подсказки — КНОПКА, а не сама иконка. `b24icons` ставит на svg
                     `aria-hidden="true"`, и в порядок фокуса он не попадает: подсказка, видимая
                     мышью, для клавиатуры и программы чтения с экрана не существовала бы вовсе
                     (WCAG 2.1.1). `aria-label` повторяет текст — он и есть всё содержание.
                     ⚠ Цвет — `base-3`, а не `base-4`: второй даёт 2,26:1 на белом, ниже планки
                     3:1 для несущего смысл элемента (WCAG 1.4.11), и в светлой теме иконка
                     сливалась с фоном. -->
                <button
                  type="button"
                  class="cursor-help items-center text-(--ui-color-base-3)"
                  aria-label="Обнулить счётчики может администратор портала — попросите его."
                >
                  <HelpIcon class="size-5" />
                </button>
              </B24Tooltip>
              <B24Button
                v-if="admin && !confirmReset"
                label="Обнулить счётчики"
                color="air-tertiary-no-accent"
                size="sm"
                @click="() => { confirmReset = true }"
              />
              <template v-else-if="admin">
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
      </template>
    </B24DashboardPanel>
  </ClientOnly>
</template>
