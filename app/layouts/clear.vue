<script setup lang="ts">
// Minimal in-portal shell — no site chrome, but inside <B24App> so b24ui components, useToast and
// the colour-mode tokens work correctly. Used by the in-portal Bitrix24 iframe pages (/install,
// /app, /settings, /import) and the standalone operator pages (/login, /queues), so they theme
// (light/dark) with the portal / OS instead of being locked to a white surface.
import { ru } from '@bitrix24/b24ui-nuxt/locale'

// B24DashboardGroup здесь стоит С ПЕРЕОПРЕДЕЛЁННОЙ базой (#259, полный объём по решению владельца
// 2026-08-03). Родная база группы — `fixed inset-0 flex overflow-hidden`: полноэкранная оболочка со
// своей прокруткой внутри. Для нас это две поломки разом, и прошлый заход из-за них группу не взял:
//   • layout общий — его делят /queues, /install, /import, /login, у которых обычный поток документа;
//     `fixed` обнуляет прокрутку страницы, и высокий контент (график очередей, диагностика установки)
//     становится недостижим;
//   • мы живём в iframe портала, высоту которого Битрикс24 подбирает ПО КОНТЕНТУ. У `fixed inset-0`
//     высота потока нулевая — приложение схлопнулось бы.
// Переопределение базы — штатный механизм b24ui (`:b24ui`), поэтому мы получаем контекст каркаса
// (его ждут `B24DashboardPanel`/`B24DashboardNavbar`) и раскладку шаблона, оставаясь в обычном
// потоке: страница скроллится документом, высота потока настоящая. Сайдбар/поиск/ресайз из шаблона
// не тянем — разделы открываются слайдером портала, навигация каркаса нам не нужна (§4 issue).
</script>

<template>
  <B24App :locale="ru">
    <B24DashboardGroup
      unit="px"
      storage="local"
      :b24ui="{ base: 'relative flex w-full min-h-screen overflow-x-hidden bg-(--ui-color-bg-content-primary) text-(--ui-color-base-1) antialiased' }"
    >
      <slot />
    </B24DashboardGroup>
  </B24App>
</template>
