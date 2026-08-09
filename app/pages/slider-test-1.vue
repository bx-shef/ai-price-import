<script setup lang="ts">
import { useTemplateRef } from 'vue'
import { useB24 } from '~/composables/useB24'
import { APP_SLIDER_PLACE_TEST2 } from '~/config/b24'

// Стенд слайдеров, страница ТЕСТ 1 (#477). Открывается слайдером с главной.
definePageMeta({ layout: 'clear' })
useHead({ title: 'Стенд слайдеров — тест 1', meta: [{ name: 'robots', content: 'noindex' }] })

const { openAppSlider, closeSlider, closeSliderViaSdk } = useB24()
// ⚠ `running` читается из журнала, чтобы гасить кнопки на время замера: два пути закрытия,
// запущенные вперехлёст, стреляют в один канал сообщений фрейма и портят само наблюдение.
const log = useTemplateRef<{
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>
  running: boolean
}>('log')
</script>

<template>
  <div class="mx-auto w-full max-w-2xl p-4 sm:p-6">
    <h1 class="text-lg font-semibold">
      Тест 1
    </h1>
    <p class="mt-1 text-xs text-(--ui-color-base-3)">
      Эта страница открыта слайдером с главной. Отсюда открывается тест 2 и закрывается эта же
      страница — двумя разными путями закрытия.
    </p>

    <div class="mt-4 flex flex-wrap gap-2">
      <B24Button
        :disabled="log?.running === true"
        label="11 — открыть тест 2"
        color="air-primary"
        @click="log?.run('11 открыть тест 2', () => openAppSlider(APP_SLIDER_PLACE_TEST2, { width: 720, title: 'Тест 2' }))"
      />
      <B24Button
        :disabled="log?.running === true"
        label="12 — закрыть тест 1"
        color="air-tertiary-no-accent"
        @click="log?.run('12 закрыть тест 1 (parent.closeApplication)', () => closeSlider())"
      />
      <!-- ⚠ Второй путь закрытия ТОЙ ЖЕ страницы. В SDK оба шлют одну и ту же команду с
           одинаковыми параметрами (проверено по исходнику), то есть разницы быть не должно вовсе —
           но «не должно» это вывод из чтения, а не наблюдение. Стенд затем и нужен. -->
      <B24Button
        :disabled="log?.running === true"
        label="12б — закрыть тест 1 (путь SDK)"
        color="air-tertiary-no-accent"
        @click="log?.run('12б закрыть тест 1 (slider.closeSliderAppPage)', () => closeSliderViaSdk())"
      />
    </div>

    <SliderProbeLog ref="log" />
  </div>
</template>
