<script setup lang="ts">
// Скелетон раскладки /app на время, пока неизвестно, настроено приложение или нет (#256).
//
// Раньше этого состояния не существовало: пока настройки грузились, `needsSetup` был false, поэтому
// отрисовывался ВЕСЬ рабочий экран, а через мгновение схлопывался в баннер «Сначала настройте» —
// выглядело как сбой. Состояний на самом деле три: неизвестно → баннер | работа.
//
// Скелетон, а не спиннер (решение владельца, как в официальном шаблоне bitrix24/templates-dashboard):
// он повторяет будущую раскладку, поэтому контент появляется НА МЕСТЕ скелетона и экран не
// перестраивается. Пропорции держим близко к реальным блокам — иначе скачок вернётся.
</script>

<template>
  <div
    class="flex flex-col gap-4"
    role="status"
    aria-label="Загружаем приложение"
  >
    <!-- Подводка над дропзоной (в рабочем состоянии здесь абзац) -->
    <B24Skeleton class="h-5 w-3/4 rounded" />

    <!-- Дропзона -->
    <B24Skeleton
      accent="accent"
      class="h-32 w-full rounded-lg"
    />

    <!-- Блок «Экономия»: две плитки-карточки в сетке, как в рабочем состоянии -->
    <div class="mt-4 grid grid-cols-1 gap-8 sm:grid-cols-2">
      <div class="flex flex-col gap-2 rounded-lg border border-(--ui-color-base-5) p-4 sm:p-6">
        <B24Skeleton
          accent="less"
          class="h-3 w-32 rounded"
        />
        <B24Skeleton class="h-7 w-24 rounded" />
      </div>
      <div class="flex flex-col gap-2 rounded-lg border border-(--ui-color-base-5) p-4 sm:p-6">
        <B24Skeleton
          accent="less"
          class="h-3 w-40 rounded"
        />
        <B24Skeleton class="h-7 w-28 rounded" />
      </div>
    </div>
  </div>
</template>
