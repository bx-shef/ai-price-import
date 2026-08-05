<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { PENDING_LEGAL_EDITIONS } from '~/config/legalNotice'
import { buildLegalNotice, editionKey, effectiveDate, formatRuDate, visibleAnnouncements } from '~/utils/legalNotice'

// Баннер об изменении юридических документов (#418, п. 9.3.3 EULA).
//
// ⚠ Это ПОЛОВИНА уведомления, а не всё. Вторая — сообщение в чат портала: баннер видит тот, кто
// зашёл, а лицензиат, месяц не открывавший приложение, узнал бы об изменении уже после того, как
// срок истёк. Пункт 9.3.4 датирует доставку по наиболее ранней из двух.
//
// ⚠ Не модалка: уведомление не должно мешать работать. И не закрывается навсегда одним кликом —
// «скрыть» действует до конца суток, потому что закрытый навсегда баннер превращает обязанность
// уведомить в один случайный клик.
const props = defineProps<{
  /** Отметить первый показ на сервере. Пусто — страница вне портала (лендинг), отмечать нечего. */
  onShown?: (key: string) => void
  /** Свернуть содержание под «Что меняется» — публичная страница, где баннер не главный. */
  compact?: boolean
}>()

const HIDE_PREFIX = 'legal-notice-hidden:'

/**
 * Сегодняшний день — в UTC, той же шкалой, что у расчёта даты вступления и у рассылки.
 *
 * ⚠ Локальные часы посетителя давали расхождение до суток с серверной половиной уведомления: в
 * UTC−11 баннер продолжал обещать «вступает в силу с …» уже после того, как редакция вступила в
 * силу, то есть утверждал будущее время о действующем. Обе половины обязаны жить по одной шкале —
 * это и есть смысл «доставки по наиболее ранней из двух дат».
 *
 * ⚠ Дата берётся на монтировании, а не на сборке: страницы пререндерятся, и вычисленная на сборке
 * дата застыла бы — баннер либо не появился бы вовсе, либо не исчез никогда.
 */
const today = ref('')
/** Ключ редакции → день, до конца которого её баннер скрыт. */
const hidden = ref<Record<string, string>>({})

const announcements = computed(() => (today.value ? visibleAnnouncements(PENDING_LEGAL_EDITIONS, today.value) : []))
// ⚠ Скрытие — ПО РЕДАКЦИИ. Общий ключ прятал разом все идущие объявления, а публикуются они пакетом
// (лицензия и Политика правятся вместе): человек, закрывший одно, не увидел бы второго, и отметка о
// его показе не ушла бы — то есть пропала бы половина доказательства по документу, который он и
// не открывал.
const shown = computed(() => announcements.value.filter(e => hidden.value[editionKey(e)] !== today.value))

onMounted(() => {
  today.value = new Date().toISOString().slice(0, 10)
  for (const e of PENDING_LEGAL_EDITIONS) {
    const key = editionKey(e)
    try {
      const v = localStorage.getItem(HIDE_PREFIX + key)
      if (v) hidden.value = { ...hidden.value, [key]: v }
    } catch { /* приватный режим браузера — считаем «не скрывали» */ }
  }
  // Отметка о показе — по факту показа, а не по факту монтирования: скрытый до завтра баннер
  // человек сегодня не видел.
  for (const e of shown.value) props.onShown?.(editionKey(e))
})

function hideForToday(key: string) {
  hidden.value = { ...hidden.value, [key]: today.value }
  try {
    localStorage.setItem(HIDE_PREFIX + key, today.value)
  } catch { /* не сохранилось — вернётся при следующей загрузке, это не ошибка */ }
}

const notices = computed(() => shown.value.map(e => ({
  key: editionKey(e),
  title: e.title,
  effective: formatRuDate(effectiveDate(e)),
  text: buildLegalNotice(e)
})))
</script>

<template>
  <!-- ⚠ `role="region"` + заголовок, а НЕ `role="status"`. Второе это live-region для того, что
       изменилось уже после загрузки: программа чтения зачитала бы весь баннер поверх текущего
       занятия человека, а при двух объявлениях создала бы две конкурирующие области. Здесь контент
       есть сразу и никуда не девается — ему нужен ориентир с именем, чтобы его можно было найти. -->
  <section
    v-for="n in notices"
    :key="n.key"
    class="legal-notice mb-4 rounded-lg border px-4 py-3 text-sm"
    role="region"
    :aria-labelledby="`legal-notice-${n.key}`"
  >
    <h2
      :id="`legal-notice-${n.key}`"
      class="font-semibold"
    >
      {{ n.text.headline }}
    </h2>
    <!-- На узком экране публичной страницы полный состав занимал 44% первого экрана и вытеснял
         заголовок с кнопками. Свёрнуто в раскрывающийся блок: обязанность уведомить выполняется
         показом и доступом к содержанию, а не тем, что оно закрывает собой страницу. Внутри
         портала (`/app`) и на широком экране блок раскрыт сразу. -->
    <details
      class="legal-notice-details"
      :open="!compact"
    >
      <summary class="legal-notice-summary">
        Что меняется
      </summary>
      <ul class="ml-4 mt-1 list-disc">
        <li
          v-for="(c, i) in n.text.changes"
          :key="i"
        >
          {{ c }}
        </li>
      </ul>
      <p class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <NuxtLink
          :to="n.text.newHref"
          class="legal-notice-link"
        >Новая редакция</NuxtLink>
        <NuxtLink
          v-if="n.text.currentHref"
          :to="n.text.currentHref"
          class="legal-notice-link"
        >{{ n.text.currentLabel }}</NuxtLink>
      </p>
      <!-- Право удалить приложение без последствий (п. 9.3.6) названо прямо: это единственное
           действие, которое остаётся у несогласного. -->
      <p class="mt-2">
        {{ n.text.optOut }}
      </p>
    </details>
    <button
      type="button"
      class="legal-notice-hide"
      @click="hideForToday(n.key)"
    >
      Скрыть до завтра
    </button>
  </section>
</template>

<style scoped>
/* ⚠ Токены проверены по отгружаемой теме b24ui. Прежняя пара ссылалась на
   `--ui-color-accent-soft-warning`, которого в теме НЕТ ВОВСЕ: Tailwind молча давал прозрачный фон,
   сборка не падала, и баннер во всех темах оставался без заливки — единственным признаком была
   рамка, а на светлой теме она давала 1,75:1 (планка 3:1). То есть уведомление, которое обязано
   быть заметным, читалось как случайная рамка. `design-tinted-warning-*` объявлены в обоих
   контекстах темы, поэтому пара «фон + текст» не может разъехаться. */
.legal-notice {
  background: var(--ui-color-design-tinted-warning-bg);
  /* ⚠ Не `accent-main-warning`: на светлой теме он давал 1,8:1 и к заливке, и к странице, то есть
     граница блока была неразличима, а сама заливка отличается от фона страницы едва-едва.
     `soft-element-orange` — тот же оранжевый, но достаточно тёмный, чтобы граница читалась. */
  border-color: var(--ui-color-accent-soft-element-orange);
  color: var(--ui-color-base-1);
}
.legal-notice-summary { cursor: pointer; margin-top: 0.25rem; }
.legal-notice-details[open] > .legal-notice-summary { list-style: none; }
.legal-notice-link { color: var(--ui-color-accent-main-link); text-decoration: underline; }
.legal-notice-hide {
  /* ⚠ `base-2`, а не `base-3`: второй давал 3,07:1 на светлой теме — ниже планки 4,5:1 для текста
     интерактивного элемента. И явный фокус: без него браузер рисует чёрный контур, невидимый на
     тёмном фоне лендинга (см. `landingShell.ts`). */
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  margin-top: 0.5rem;
  color: var(--ui-color-base-2);
  background: none;
  border: 0;
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
}
.legal-notice-hide:focus-visible {
  outline: 2px solid var(--ui-color-accent-main-primary);
  outline-offset: 2px;
}
</style>
