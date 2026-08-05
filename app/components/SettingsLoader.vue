<script setup lang="ts">
// Скелетон раскладки /settings (#408).
//
// ⚠ Что скрывает: до правки форма рисовалась ДО прихода серверной копии, то есть со значениями по
// умолчанию. Администратор видел настройки, которых не выбирал, и они на глазах подменялись
// сохранёнными. На медленной сети это читается как сброс настроек — самая тревожная из возможных
// трактовок для экрана, где лежит конфигурация записи в CRM.
//
// ⚠ Прежнее полумерное решение — `pointer-events-none opacity-50` на форме во время загрузки — от
// этого не спасало: приглушённые значения по умолчанию всё равно НАПИСАНЫ, а человек читает то,
// что видит, а не то, что кликабельно.
//
// Повторяет блоки-пары страницы: тонированная шапка + тело с полями.
</script>

<template>
  <div class="flex flex-col gap-4 sm:gap-6">
    <section
      v-for="i in 3"
      :key="i"
    >
      <!-- Шапка блока -->
      <B24Skeleton
        accent="less"
        class="h-16 w-full rounded-none sm:rounded-t-3xl"
      />
      <!-- Тело блока: подпись + поле, дважды -->
      <div class="space-y-6 rounded-none border border-t-0 border-(--ui-color-base-6) p-4 sm:rounded-b-3xl sm:p-6">
        <div
          v-for="j in 2"
          :key="j"
          class="space-y-2"
        >
          <B24Skeleton
            accent="less"
            class="h-3 w-56 rounded"
          />
          <B24Skeleton class="h-9 w-full rounded-lg" />
        </div>
      </div>
    </section>
  </div>
</template>
