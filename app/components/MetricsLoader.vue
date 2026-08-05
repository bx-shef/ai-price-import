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
    <!-- Подводка -->
    <B24Skeleton class="h-4 w-2/3 rounded" />

    <!-- Плитки экономии (в рабочем состоянии — B24PageGrid из одной-двух карточек) -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div
        v-for="i in 2"
        :key="i"
        class="flex flex-col gap-2 rounded-3xl border border-(--ui-color-base-6) p-4 sm:p-6"
      >
        <B24Skeleton
          accent="less"
          class="h-3 w-32 rounded"
        />
        <B24Skeleton class="h-6 w-24 rounded" />
      </div>
    </div>

    <!-- Успешность -->
    <div class="flex items-center justify-between rounded-3xl border border-(--ui-color-base-6) p-4 sm:p-6">
      <B24Skeleton
        accent="less"
        class="h-4 w-48 rounded"
      />
      <B24Skeleton class="h-5 w-14 rounded" />
    </div>

    <!-- Счётчики: тонированная шапка + строки списка -->
    <div>
      <B24Skeleton
        accent="less"
        class="h-11 w-full rounded-t-3xl"
      />
      <div class="rounded-b-3xl border border-t-0 border-(--ui-color-base-6) p-4 sm:p-6">
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
