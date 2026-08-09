<script setup lang="ts">
import { useTemplateRef } from 'vue'
import { useB24 } from '~/composables/useB24'

// Стенд слайдеров, страница ТЕСТ 2 (#477). Открывается слайдером из теста 1 — то есть слайдер
// поверх слайдера. Ради этого стенд и собран: вложенное открытие не наблюдалось ни разу.
definePageMeta({ layout: 'clear' })
useHead({ title: 'Стенд слайдеров — тест 2', meta: [{ name: 'robots', content: 'noindex' }] })

const { closeSlider, closeSliderViaSdk } = useB24()
const log = useTemplateRef<{ run: (label: string, fn: () => Promise<unknown>) => Promise<void> }>('log')
</script>

<template>
  <div class="mx-auto w-full max-w-2xl p-4 sm:p-6">
    <h1 class="text-lg font-semibold">
      Тест 2
    </h1>
    <!-- ⚠ Обе кнопки заявляют одно и то же — «закрыть эту страницу», — и различаются ПУТЁМ вызова
         (решение владельца 09.08.2026: «кнопка 22 закрывает страницу тест 2»). Смысл пары в том,
         что стенд показывает, ЧТО закрылось на самом деле: только тест 2 или весь стек вместе с
         тестом 1. Это и есть главный вопрос вложенности, и вывести его из справочника нельзя. -->
    <p class="mt-1 text-xs text-(--ui-color-base-3)">
      Эта страница открыта слайдером ИЗ теста 1 — слайдер поверх слайдера. Обе кнопки закрывают эту
      страницу, но разными путями. Смотрите, что закроется: только тест 2 или вместе с тестом 1.
    </p>

    <div class="mt-4 flex flex-wrap gap-2">
      <B24Button
        label="21 — закрыть тест 2 (путь SDK)"
        color="air-tertiary-no-accent"
        @click="log?.run('21 закрыть тест 2 (slider.closeSliderAppPage)', () => closeSliderViaSdk())"
      />
      <B24Button
        label="22 — закрыть тест 2"
        color="air-primary"
        @click="log?.run('22 закрыть тест 2 (parent.closeApplication)', () => closeSlider())"
      />
    </div>

    <SliderProbeLog ref="log" />
  </div>
</template>
