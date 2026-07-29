<script setup lang="ts">
// Minimal in-portal shell — no site chrome, but inside <B24App> so b24ui components, useToast and
// the colour-mode tokens work correctly. Used by the in-portal Bitrix24 iframe pages (/install,
// /app, /settings, /import) and the standalone operator pages (/login, /queues), so they theme
// (light/dark) with the portal / OS instead of being locked to a white surface.
import { ru } from '@bitrix24/b24ui-nuxt/locale'

// B24DashboardGroup/B24DashboardPanel из официального шаблона здесь СОЗНАТЕЛЬНО не используются (#259).
// Их база — `fixed inset-0 flex overflow-hidden`, то есть полноэкранная оболочка со своей прокруткой
// внутри. Для нас это две проблемы, обе неприемлемые:
//   • layout общий — его делят /queues, /install, /import, /login, у которых обычный поток документа;
//     `fixed` обнуляет прокрутку страницы, и высокий контент (график очередей, диагностика установки)
//     становится недостижим;
//   • мы живём в iframe портала, высоту которого Битрикс24 подбирает ПО КОНТЕНТУ. У `fixed inset-0`
//     высота потока нулевая — приложение схлопнулось бы. Проверить это можно только в живом портале.
// Из шаблона взято то, что работает в обычном потоке: навбар как шапка страницы и карточки-плитки.
</script>

<template>
  <B24App :locale="ru">
    <div class="min-h-screen w-full overflow-x-hidden bg-(--ui-color-bg-content-primary) text-(--ui-color-base-1) antialiased">
      <slot />
    </div>
  </B24App>
</template>
