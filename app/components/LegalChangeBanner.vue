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
}>()

const HIDE_KEY = 'legal-notice-hidden'

/**
 * Сегодняшний день по локальным часам посетителя.
 *
 * ⚠ Дата берётся на монтировании, а не на сборке: страницы пререндерятся, и вычисленная на сборке
 * дата застыла бы — баннер либо не появился бы вовсе, либо не исчез никогда.
 */
const today = ref('')
const hiddenUntil = ref('')

const announcements = computed(() => (today.value ? visibleAnnouncements(PENDING_LEGAL_EDITIONS, today.value) : []))
const shown = computed(() => (hiddenUntil.value === today.value ? [] : announcements.value))

onMounted(() => {
  const d = new Date()
  today.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  try {
    hiddenUntil.value = String(localStorage.getItem(HIDE_KEY) ?? '')
  } catch { /* приватный режим браузера — считаем «не скрывали» */ }
  // Отметка о показе — по факту показа, а не по факту монтирования: скрытый до завтра баннер
  // человек сегодня не видел.
  for (const e of shown.value) props.onShown?.(editionKey(e))
})

function hideForToday() {
  hiddenUntil.value = today.value
  try {
    localStorage.setItem(HIDE_KEY, today.value)
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
  <div
    v-for="n in notices"
    :key="n.key"
    class="mb-4 rounded-lg border border-(--ui-color-accent-main-warning) bg-(--ui-color-accent-soft-warning) px-4 py-3 text-sm"
    role="status"
  >
    <p class="font-semibold">
      {{ n.text.headline }}
    </p>
    <p class="mt-1">
      Что меняется:
    </p>
    <ul class="ml-4 list-disc">
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
        class="underline"
      >Новая редакция</NuxtLink>
      <NuxtLink
        v-if="n.text.currentHref"
        :to="n.text.currentHref"
        class="underline"
      >{{ n.text.currentLabel }}</NuxtLink>
    </p>
    <!-- Право удалить приложение без последствий (п. 9.3.6) названо прямо и не спрятано под
         «подробнее»: это единственное действие, которое остаётся у несогласного. -->
    <p class="mt-2">
      {{ n.text.optOut }}
    </p>
    <button
      type="button"
      class="mt-2 inline-flex min-h-11 items-center text-(--ui-color-base-3) underline"
      @click="hideForToday"
    >
      Скрыть до завтра
    </button>
  </div>
</template>
