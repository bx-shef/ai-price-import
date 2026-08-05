<script setup lang="ts">
// Скелетон раскладки /metrics (#408).
//
// ⚠ Повторяет ИМЕННО эту раскладку, а не общий прямоугольник: смысл скелетона в том, что контент
// появляется НА МЕСТЕ заглушки и экран не перестраивается. Универсальная заглушка этого не даёт —
// она сама вызывает тот скачок, ради устранения которого её ставят.
//
// Что скрывает: до правки страница рисовала плитки сразу, и пока данные шли, счётчики были нулевые.
// Человек читал «0 документов» как факт о своём портале; хуже — при нулях срабатывала ветка пустого
// состояния, и портал, где импорт шёл месяцами, на долю секунды сообщал, что импортов не было.
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- ⚠ Полосы под подводку здесь НЕТ, и это важно: сам абзац «Сколько документов приложение
         обработало…» стоит ВЫШЕ состояния загрузки и виден всё время. Заглушка рисовала под ним
         серого двойника, и при готовности всё содержимое подпрыгивало вверх на ~28 px. -->

    <!-- Плитки экономии. ⚠ Одна колонка: вторая (денежная) плитка появляется только когда задана
         ставка часа, а по умолчанию её нет — заглушка из двух колонок расходилась с реальностью
         на каждом портале, где ставку не задали. -->
    <B24PageGrid class="sm:grid-cols-1 lg:grid-cols-1">
      <div
        class="flex flex-col gap-2 rounded-lg border border-(--ui-color-design-outline-stroke) p-4 sm:p-6"
      >
        <B24Skeleton
          accent="less"
          class="h-3 w-32 rounded"
        />
        <B24Skeleton class="h-6 w-24 rounded" />
      </div>
    </B24PageGrid>

    <!-- Успешность: в настоящей карточке под строкой есть абзац-пояснение — отсюда высота. -->
    <div class="rounded-lg border border-(--ui-color-design-outline-stroke) p-4 sm:p-6">
      <div class="flex items-center justify-between">
        <B24Skeleton
          accent="less"
          class="h-4 w-48 rounded"
        />
        <B24Skeleton class="h-5 w-14 rounded" />
      </div>
      <B24Skeleton
        accent="less"
        class="mt-2 h-8 w-full rounded"
      />
    </div>

    <!-- Счётчики: тонированная шапка + строки списка -->
    <div>
      <!-- Шапка «Счётчики» — тонированная карточка, а не тонкая серая полоса: `accent="less"` на
           светлой теме почти сливается с фоном (≈1,13:1), и вместо шапки была пустота. -->
      <B24Skeleton class="h-[69px] w-full rounded-t-3xl" />
      <div class="rounded-b-3xl border border-t-0 border-(--ui-color-design-outline-stroke) p-4 sm:p-6">
        <div
          v-for="i in 5"
          :key="i"
          class="flex items-center justify-between py-2.5"
        >
          <B24Skeleton
            accent="less"
            class="h-4 w-40 rounded"
          />
          <B24Skeleton class="h-4 w-10 rounded" />
        </div>
      </div>
    </div>
  </div>
</template>
