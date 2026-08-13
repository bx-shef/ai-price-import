<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMetrics } from '~/composables/useMetrics'
import { formatMinutes } from '~/utils/savings'

// Карточка «Экономия» на главном экране: две крупные цифры, счётчики и обнуление (#523).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ КОМПОНЕНТ. Блок жил прямо в `app/pages/app.vue` и занимал там 130 строк из 808.
// Страница читается гардами ПО ТЕКСТУ ШАБЛОНА (порядок блоков, замок на время пачки, гейт админа),
// и чем больше в ней всего, тем больше проверок смотрят в один файл — а правки такой страницы
// конфликтуют между параллельными ветками.
//
// ⚠ Метрики компонент грузит САМ и отдаёт наружу `reload()`: страница обновляет их после пачки
// (#444), но владеть состоянием, которое рисует только эта карточка, ей незачем.
// ⚠ Следствие, принятое осознанно: в мобильном приложении карточки нет — значит нет и запроса за
// метриками. Прежде страница ходила за ними всегда, даже когда показывать было нечего.

const props = defineProps<{
  /** Идёт пачка загрузок: разрушительные действия гаснут, оформление приглушается. */
  busy: boolean
  /** Признак администратора — СЕРВЕРНЫЙ (`useSettings`), только для показа: разрешает сервер. */
  isAdmin: boolean
  /** Мобильное приложение Битрикс24 (`useDevice().isBitrixMobile`) — карточки там нет вовсе. */
  mobile: boolean
}>()

const emit = defineEmits<{ openMetrics: [] }>()

const { counters, savings, moneyBlocker, resetting, error: metricsError, load, reset: resetMetrics } = useMetrics()

// Two-step reset (no window.confirm): «Сбросить» → подтверждение рядом. Подтверждение держим
// видимым (чтобы «Да» показало «Сбрасываем…»/`disabled`), пока запрос не завершится.
const confirmReset = ref(false)
async function doReset(): Promise<void> {
  try {
    await resetMetrics()
  } finally {
    confirmReset.value = false
  }
}

// Деньги показываем, только если админ портала задал стоимость часа (#270): валюту берём из самого
// портала и не выдумываем. Нет ставки — плитки нет, и сетка схлопывается в одну колонку, иначе
// одинокая плитка «Сэкономлено времени» висела бы на половине ширины с пустотой рядом.
const hasMoneyTile = computed(() => !!savings.value && savings.value.moneySaved !== null)
// Причина отсутствия денежной плитки простыми словами. Молчание здесь и было дефектом: админ,
// задавший ставку, видел пустоту и не мог отличить «не сработало» от «не хватает ещё настройки».
const moneyHint = computed(() => {
  if (moneyBlocker.value === 'no-rate') return 'Чтобы видеть экономию в деньгах, укажите стоимость часа работы сотрудника в настройках приложения.'
  if (moneyBlocker.value === 'no-currency') return 'Стоимость часа задана, но в портале нет базовой валюты — сумму не в чем считать. Задайте базовую валюту в настройках валют Битрикс24.'
  return ''
})
const moneySavedText = computed(() => (savings.value?.moneySaved ?? 0).toLocaleString('ru-RU'))

// Грузим сами — но только там, где карточка вообще есть.
if (!props.mobile) void load()

/** Перечитать метрики (страница зовёт это, когда снимается замок пачки, #444). */
defineExpose({ reload: (opts?: { silent?: boolean }) => load(opts) })
</script>

<template>
  <!-- ⚠ В МОБИЛЬНОМ ПРИЛОЖЕНИИ карточки нет (#507). Основание то же, по которому там скрыты
       шестерёнка и ссылка на подробные метрики: это смотрят и правят с компьютера. Две крупные
       цифры и разрушительное «Сбросить» на телефоне занимали экран перед журналом, ради которого
       приложение и открывают со склада.
       ⚠ Скрыто условным рендером, а не по ширине: спрятанное CSS-ом осталось бы в дереве и читалось
       бы программой чтения.
       ⚠ `opacity` остаётся ОФОРМЛЕНИЕМ, а блокируют настоящие `:disabled` на самих кнопках (#443):
       `pointer-events-none` держит только мышь, с клавиатуры такая кнопка нажимается. -->
  <B24Card
    v-if="!mobile"
    variant="outline"
    class="transition-opacity"
    :class="busy ? 'opacity-60' : ''"
    data-testid="savings-card"
  >
    <div class="flex flex-wrap items-start gap-x-8 gap-y-4">
      <!-- Плитки — B24PageGrid + B24PageCard каркаса (#259) вместо самодельных цифр. -->
      <B24PageGrid :class="hasMoneyTile ? 'flex-1 sm:grid-cols-2 lg:grid-cols-2' : 'flex-1 sm:grid-cols-1 lg:grid-cols-1'">
        <B24PageCard
          variant="tinted-no-accent"
          title="Сэкономлено времени"
          :b24ui="{ title: 'text-xs uppercase tracking-wide text-(--ui-color-base-3)' }"
        >
          <p class="text-[22px] leading-tight font-semibold">
            {{ savings ? formatMinutes(savings.minutesSaved) : '—' }}
          </p>
        </B24PageCard>
        <!-- Деньги показываем, только если админ задал стоимость часа: валюта берётся из самого
             портала, выдумывать её нельзя (#270). Не задана — плитки просто нет. -->
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
        <!-- Плитки нет — говорим, чего не хватает, вместо пустого места. -->
        <p
          v-else-if="moneyHint"
          class="self-center text-xs text-(--ui-color-base-3)"
        >
          {{ moneyHint }}
        </p>
      </B24PageGrid>
      <div class="ml-auto flex flex-col items-end gap-2 text-xs">
        <!-- «Подробные метрики» скрыта в мобильном приложении Б24 — узкий экран. Слайдер открывает
             страница: путь к порталу её, а не карточки. -->
        <button
          type="button"
          :disabled="busy"
          :aria-label="busy ? 'Подробные метрики недоступны, пока идёт загрузка' : undefined"
          class="text-sm font-medium text-(--ui-color-accent-main-link) hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60"
          data-testid="metrics-details"
          @click="emit('openMetrics')"
        >
          Подробные метрики →
        </button>
        <!-- Сброс — только администратору (#411). Признак СЕРВЕРНЫЙ (`useSettings`, свой запрос за
             настройками всё равно идёт). ⚠ Это вторая точка входа в то же разрушительное действие:
             первая правка закрыла её только на `/metrics`, и на самом посещаемом экране сотрудник
             по-прежнему соглашался «Да, обнулить» и получал 403 после согласия. Подсказки тут нет
             намеренно: карточка узкая, а объяснение живёт на странице подробных метрик. -->
        <B24Button
          v-if="isAdmin && !confirmReset"
          label="Сбросить"
          color="air-tertiary-no-accent"
          size="xs"
          :disabled="busy"
          :aria-label="busy ? 'Сброс счётчиков недоступен, пока идёт загрузка' : undefined"
          data-testid="metrics-reset"
          @click="() => { confirmReset = true }"
        />
        <!-- ⚠ Причина — СЛОВАМИ, а не только приглушением (#475). Выключенная кнопка без объяснения
             неотличима от сломанной, и человек начинает жать её сильнее. Строка одна на всю
             карточку: подпись у каждой кнопки читалась бы как три разные поломки. -->
        <p
          v-if="busy"
          class="text-xs text-(--ui-color-base-3)"
          role="status"
        >
          Пока идёт загрузка, счётчики не меняем
        </p>
        <div
          v-else-if="isAdmin && confirmReset"
          class="flex flex-wrap items-center justify-end gap-2"
        >
          <span class="text-(--ui-color-base-3)">Обнулить счётчики экономии? Документы в CRM останутся.</span>
          <B24Button
            color="air-primary-alert"
            size="xs"
            :loading="resetting"
            :disabled="resetting || busy"
            :label="resetting ? 'Сбрасываем…' : 'Да, обнулить'"
            data-testid="metrics-reset-confirm"
            @click="doReset"
          />
          <!-- ⚠ «Отмена» НЕ гаснет по busy (#475): погасив её заодно с «Да, обнулить», мы заперли бы
               человека в подтверждении до конца пачки. -->
          <B24Button
            label="Отмена"
            color="air-tertiary-no-accent"
            size="xs"
            data-testid="metrics-reset-cancel"
            @click="() => { confirmReset = false }"
          />
        </div>
      </div>
    </div>
    <B24Alert
      v-if="metricsError"
      class="mt-3"
      color="air-primary-warning"
      size="sm"
      :title="metricsError"
    />
    <p
      class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-(--ui-color-base-3) transition-opacity"
      :class="busy ? 'opacity-60' : ''"
    >
      <span>Документов: {{ counters.docs || 0 }}</span>
      <span>Создано в CRM: {{ counters.created || 0 }}</span>
      <span>Позиций: {{ counters.lines || 0 }}</span>
    </p>
  </B24Card>
</template>
