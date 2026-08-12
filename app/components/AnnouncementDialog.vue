<script setup lang="ts">
import { computed } from 'vue'
import { createReusableTemplate, useMediaQuery } from '@vueuse/core'
import { useAnnouncement } from '~/composables/useAnnouncement'
import type { Announcement } from '~/utils/announcement'
import { renderMarkdown } from '~/utils/markdownLite'
import { useSettingsSync } from '~/composables/useSettingsSync'
import { ANNOUNCEMENT_CHECK_JITTER_MS } from '~/utils/announcementPull'

// Объявление издателя (#469): на компьютере — модальное окно, на телефоне — шторка снизу.
//
// ⚠ Два носителя, а не один адаптивный: модальное окно на узком экране мобильного приложения
// Битрикс24 занимает его целиком и закрывается жестом, которого у модалки нет, — шторка там
// привычнее и не выглядит аварией. Содержимое общее, отличается только оболочка.
//
// ⚠ Показ РЕШАЕТ композабл, а не разметка: отметка «видел» живёт в браузере, срок проверяется и на
// сервере, и здесь. Разметка знает только «открыть/закрыть».
//
// ⚠ ЗАГОЛОВОК и ПОДПИСЬ КНОПКИ печатаются через `{{ }}` — разметке в них делать нечего. А ТЕКСТ с
// 12.08.2026 проходит через мини-рендер `markdownLite` (#473 п.6, решение владельца): владельцу
// нужны абзацы, списки и выделение, иначе объявление на два экрана не читается.
// ⚠ Это ВТОРОЕ и последнее место в проекте с `v-html`, и оно намеренно того же вида, что первое:
// не «включили разметку», а взяли ТОТ ЖЕ мини-рендер, который уже держит юридические страницы. Он
// экранирует ДО разбора конструкций, поэтому сырой HTML в тексте выводится ВИДИМЫМ ТЕКСТОМ, а не
// исполняется; ссылки пропускаются только на `#`, `/` и http(s) — `javascript:` и `data:` остаются
// строкой. Полный HTML отклонён: канал широковещательный, и цена ошибки — исполнение скрипта
// внутри CRM всех клиентов сразу.
// ⚠ Ссылки открываются НОВОЙ ВКЛАДКОЙ (`newTab`): обычная увела бы сам фрейм приложения на чужой
// сайт внутри портала, откуда человеку некуда вернуться. Картинка вставляется
// `:src` из `data:`-адреса, тип которого проверен на сервере закрытым списком растровых форматов
// (SVG отвергается — это документ со скриптами).
// ⚠ ПРЕДПРОСМОТР ИДЁТ ЧЕРЕЗ ЭТОТ ЖЕ КОМПОНЕНТ (#473 п.4), а не через свою карточку в консоли.
// Прежде консоль рисовала пересказ — заголовок, картинку и строку «Кнопка «…» → https://…», — то
// есть проверить можно было ДАННЫЕ, но не ВИД: помещается ли заголовок в шапку, не разъезжается ли
// картинка, где встанут кнопки. А вид тут и есть предмет проверки. Занятно, что рядом в консоли уже
// было написано, почему свой рендер недопустим, — и сделан был именно он.
// ⚠ В режиме предпросмотра компонент ИНЕРТЕН: не спрашивает сервер, не подписывается на живой
// сигнал и не ставит отметку «видел». Иначе оператор, посмотрев объявление, лишил бы себя же его
// показа как сотрудника.
const props = defineProps<{
  /** Объявление ОТ СЕРВЕРА для предпросмотра. Не задано — обычный боевой режим. */
  preview?: Announcement | null
  /** Чем показать в предпросмотре: шторкой или окном. В боевом режиме решает устройство. */
  previewAs?: 'sheet' | 'modal'
}>()
const emit = defineEmits<{ close: [] }>()
const isPreview = computed(() => !!props.preview)

const live = useAnnouncement()
const announcement = computed(() => props.preview ?? live.announcement.value)
const open = computed(() => (isPreview.value ? true : live.open.value))

function dismiss(): void {
  if (isPreview.value) {
    emit('close')
    return
  }
  live.dismiss()
}

// Общее тело и кнопки — один шаблон на оба носителя.
// ⚠ Кнопка «Закрыть» зовёт НАШ `dismiss`, а не `close` из слота подвала: закрытие обязано ставить
// отметку «видел», и через слот она бы не ставилась — окно закрылось бы, а завтра пришло снова.
const [DefineContent, ReuseContent] = createReusableTemplate()
const [DefineActions, ReuseActions] = createReusableTemplate()

// Спрашиваем сразу при монтировании: объявление редкое, и человек должен увидеть его в тот заход,
// когда оно уже опубликовано, а не следующим.
if (!props.preview) void live.check()

// ⚠ И ЖИВОЙ СИГНАЛ (#478). Одного вопроса при монтировании мало: вкладку рабочего экрана в портале
// не перезагружают сутками, поэтому у сотрудника с уже открытым экраном объявление не появилось бы
// ВООБЩЕ. Канал «сказать всем клиентам сразу» говорил не сразу, а когда-нибудь, а для новости со
// сроком это обесценивает сам канал: акция кончится раньше, чем объявление кого-то догонит.
//
// ⚠ Подписка заводится СИНХРОННО в setup: после `await` теряется активная область эффектов, и
// автоматическое снятие подписки при размонтировании стало бы пустышкой — pull-клиент повис бы.
// Тот же порядок, что у подписки на настройки.
//
// ⚠ Событию НЕ ВЕРИМ на слово: оно лишь повод сходить и спросить. Текст, картинку и срок отдаёт наш
// проверенный роут — в самом событии их нет по построению (см. `announcementPull.ts`).
// ⚠ Запасной путь остаётся: если pull на портале выключен, объявление по-прежнему появится при
// следующем открытии экрана. Живой сигнал ускоряет доставку, а не заменяет её.
const { subscribeAnnouncement } = useSettingsSync()
if (!props.preview) {
  subscribeAnnouncement(() => {
  // ⚠ СЛУЧАЙНАЯ ЗАДЕРЖКА перед запросом, и это не украшение. Сигнал получают ВСЕ сотрудники ВСЕХ
  // порталов одновременно — момент выбирает издатель, — а запрос за объявлением не бесплатный: он
  // проверяет фрейм-токен, то есть идёт в базу и делает исходящий вызов к порталу. Без разброса
  // штатная публикация сама себе устраивала бы всплеск на самом дорогом пути ровно в одну секунду.
  // Объявление — не срочность: несколько секунд разницы человек не заметит, а всплеска не будет.
    setTimeout(() => void live.check(), Math.floor(Math.random() * ANNOUNCEMENT_CHECK_JITTER_MS))
  })
}

/**
 * Носитель: шторка или окно.
 *
 * ⚠ **Решает `isBitrixMobile`, а не ширина вьюпорта** (#473 п.3). Прежняя редакция спрашивала
 * `max-width: 639px` и объявляла телефоном всё, что уже 640 — а мобильное приложение Битрикс24
 * бывает и шире (планшет, крупный телефон в альбомной, фрейм побольше). Там открывалось модальное
 * окно, хотя и компонент, и консоль оператора обещают сотруднику шторку. Это тот же класс дефекта,
 * что разобран в #472: ширина — свойство ОКНА, а не устройства, и признаком клиента быть не может.
 * Верный признак даёт b24ui (`useDevice`, по User-Agent) и он уже применяется на `/app`.
 *
 * ⚠ Медиазапрос ОСТАЁТСЯ, но вторым слагаемым и только для узкого браузера: на телефоне вне портала
 * (демо, открытая ссылка) `isBitrixMobile` ложен, а модальное окно там так же неудобно.
 */
const { isBitrixMobile } = useDevice()
const isNarrow = useMediaQuery('(max-width: 639px)')
const asSheet = computed(() => (props.previewAs
  ? props.previewAs === 'sheet'
  : isBitrixMobile.value || isNarrow.value))

/**
 * Текст объявления в разметке.
 *
 * ⚠ Считается ЗДЕСЬ, а не на сервере, и это важно: сервер хранит ИСХОДНЫЙ текст, поэтому правка
 * рендера действует на уже опубликованное объявление, а не только на будущее. Хранить готовый HTML
 * значило бы законсервировать сегодняшнюю версию правил экранирования в Redis.
 */
const textHtml = computed(() => renderMarkdown(announcement.value?.text ?? '', { newTab: true }))

function onOpenChange(next: boolean): void {
  if (!next) dismiss()
}

/** Кнопка со ссылкой: уводим в новую вкладку и отмечаем прочитанным. */
function openLink(): void {
  // ⚠ В предпросмотре кнопка НЕ уводит: оператор проверяет вид, а не ходит по ссылке. Открывать
  // вкладку значило бы менять то, что проверяют, самим актом проверки.
  const url = announcement.value?.linkUrl
  if (url && !isPreview.value) window.open(url, '_blank', 'noopener,noreferrer')
  dismiss()
}
</script>

<template>
  <!-- ⚠ ДВА явных компонента, а не `<component :is>` со строкой: при динамическом `is` vue-tsc
       не проверяет ни пропсы, ни слоты — опечатка в имени пропа прошла бы typecheck, а `side`
       уезжал бы в модалку, где такого пропа нет вовсе. Общее тело вынесено в переиспользуемый
       шаблон (`createReusableTemplate`), поэтому разметка не дублируется — тот же приём, что
       внутри самого b24ui. -->
  <DefineContent>
    <div class="flex flex-col gap-4">
      <img
        v-if="announcement?.image"
        :src="announcement.image"
        :alt="announcement.title"
        class="max-h-60 w-full rounded-lg object-contain"
      >
      <!-- ⚠ `v-html` здесь допустим ровно потому, что источник — наш мини-рендер, а не текст: он
           экранирует ДО разбора, и сырой HTML из поля владельца выводится видимым текстом. Класс
           `announcement-text` красит списки и ссылки — у мини-рендера своих стилей нет. -->
      <!-- eslint-disable-next-line vue/no-v-html -- источник — markdownLite, экранирует до разбора -->
      <div
        class="announcement-text text-sm text-(--ui-color-base-2)"
        v-html="textHtml"
      />
    </div>
  </DefineContent>

  <DefineActions>
    <div class="flex w-full flex-wrap justify-end gap-2">
      <B24Button
        label="Закрыть"
        color="air-tertiary-no-accent"
        @click="dismiss"
      />
      <B24Button
        v-if="announcement?.linkUrl"
        :label="announcement.linkLabel || 'Подробнее'"
        color="air-primary"
        @click="openLink"
      />
    </div>
  </DefineActions>

  <template v-if="announcement">
    <B24Slideover
      v-if="asSheet"
      :open="open"
      side="bottom"
      :title="announcement.title"
      :unmount-on-hide="true"
      @update:open="onOpenChange"
    >
      <template #body>
        <ReuseContent />
      </template>
      <template #footer>
        <ReuseActions />
      </template>
    </B24Slideover>

    <B24Modal
      v-else
      :open="open"
      :title="announcement.title"
      :unmount-on-hide="true"
      @update:open="onOpenChange"
    >
      <template #body>
        <ReuseContent />
      </template>
      <template #footer>
        <ReuseActions />
      </template>
    </B24Modal>
  </template>
</template>

<style scoped>
/* У мини-рендера своих стилей нет — задаём минимум, чтобы списки и ссылки читались. Скоуплено на
   компонент: класс общий с юридическими страницами, но там своё оформление. */
.announcement-text :deep(p + p) {
  margin-top: 0.5rem;
}
.announcement-text :deep(ul),
.announcement-text :deep(ol) {
  margin: 0.5rem 0;
  padding-inline-start: 1.25rem;
  list-style: disc;
}
.announcement-text :deep(ol) {
  list-style: decimal;
}
.announcement-text :deep(a) {
  color: var(--ui-color-accent-main-link);
  text-decoration: underline;
}
.announcement-text :deep(strong) {
  font-weight: 600;
}
</style>
