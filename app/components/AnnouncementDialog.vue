<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import { useAnnouncement } from '~/composables/useAnnouncement'

// Объявление издателя (#469): на компьютере — модальное окно, на телефоне — шторка снизу.
//
// ⚠ Два носителя, а не один адаптивный: модальное окно на узком экране мобильного приложения
// Битрикс24 занимает его целиком и закрывается жестом, которого у модалки нет, — шторка там
// привычнее и не выглядит аварией. Содержимое общее, отличается только оболочка.
//
// ⚠ Показ РЕШАЕТ композабл, а не разметка: отметка «видел» живёт в браузере, срок проверяется и на
// сервере, и здесь. Разметка знает только «открыть/закрыть».
//
// ⚠ Текст, заголовок и подпись кнопки печатаются через `{{ }}` — их пишет владелец в консоли
// оператора, но идут они в чужой портал, и разметке в них делать нечего. Картинка вставляется
// `:src` из `data:`-адреса, тип которого проверен на сервере закрытым списком растровых форматов
// (SVG отвергается — это документ со скриптами).
const { announcement, open, check, dismiss } = useAnnouncement()

// Спрашиваем сразу при монтировании: объявление редкое, и человек должен увидеть его в тот заход,
// когда оно уже опубликовано, а не следующим.
void check()

/** Ниже `sm` (640px) — телефон и мобильное приложение портала. */
const isPhone = useMediaQuery('(max-width: 639px)')

function onOpenChange(next: boolean): void {
  if (!next) dismiss()
}

/** Кнопка со ссылкой: уводим в новую вкладку и отмечаем прочитанным. */
function openLink(): void {
  const url = announcement.value?.linkUrl
  if (url) window.open(url, '_blank', 'noopener,noreferrer')
  dismiss()
}
</script>

<template>
  <component
    :is="isPhone ? 'B24Slideover' : 'B24Modal'"
    v-if="announcement"
    :open="open"
    :side="isPhone ? 'bottom' : undefined"
    :title="announcement.title"
    :unmount-on-hide="true"
    @update:open="onOpenChange"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <img
          v-if="announcement.image"
          :src="announcement.image"
          :alt="announcement.title"
          class="max-h-60 w-full rounded-lg object-contain"
        >
        <!-- `whitespace-pre-line`: владелец пишет абзацы переводами строк, а не разметкой. -->
        <p class="whitespace-pre-line text-sm text-(--ui-color-base-2)">
          {{ announcement.text }}
        </p>
      </div>
    </template>

    <template #footer="{ close }">
      <div class="flex w-full flex-wrap justify-end gap-2">
        <B24Button
          label="Закрыть"
          color="air-tertiary-no-accent"
          @click="close"
        />
        <B24Button
          v-if="announcement.linkUrl"
          :label="announcement.linkLabel || 'Подробнее'"
          color="air-primary"
          @click="openLink"
        />
      </div>
    </template>
  </component>
</template>
