<script setup lang="ts">
// Minimal in-portal shell — no site chrome, but inside <B24App> so b24ui components, useToast and
// the colour-mode tokens work correctly. Used by the in-portal Bitrix24 iframe pages (/install,
// /app, /settings, /import) and the standalone operator pages (/login, /queues), so they theme
// (light/dark) with the portal / OS instead of being locked to a white surface.
import { ru } from '@bitrix24/b24ui-nuxt/locale'

// B24DashboardGroup здесь стоит С НЕЙТРАЛИЗОВАННОЙ базой (#259, полный объём по решению владельца
// 2026-08-03). Родная база группы — `fixed inset-0 flex overflow-hidden`: полноэкранная оболочка со
// своей прокруткой внутри. Для нас это две поломки разом, и прошлый заход из-за них группу не взял:
//   • layout общий — его делят /queues, /install, /import, /login, у которых обычный поток документа;
//     `fixed` обнуляет прокрутку страницы, и высокий контент (график очередей, диагностика установки)
//     становится недостижим;
//   • мы живём в iframe портала, высоту которого Битрикс24 подбирает ПО КОНТЕНТУ. У `fixed inset-0`
//     высота потока нулевая — приложение схлопнулось бы.
// ⚠ `:b24ui` НЕ заменяет базу, а домердживается через tailwind-merge: выживает всё, чему в override
// не нашлось КОНФЛИКТУЮЩЕГО класса той же группы (это подтвердили ревьюеры прогоном tv 3.2.2).
// Поэтому каждый родной класс снят явной парой: `relative` ← `fixed`, `inset-auto` ← `inset-0`,
// `overflow-visible` ← `overflow-hidden` (`overflow-x-hidden` — ДРУГАЯ группа merge и hidden бы не
// снял). `flex-col`, а не родной row: у нас нет сайдбара, и в строчном flex страницы БЕЗ панели
// (/install, /login) становились fit-content-элементами — карточка логина теряла центрирование.
// Сайдбар/поиск/ресайз из шаблона не тянем — разделы открываются слайдером портала, навигация
// каркаса нам не нужна (§4 issue); поэтому же нет unit/storage — сохранять каркасу нечего.
</script>

<template>
  <B24App :locale="ru">
    <B24DashboardGroup
      :b24ui="{ base: 'relative inset-auto flex flex-col w-full min-h-screen overflow-visible overflow-x-hidden bg-(--ui-color-bg-content-primary) text-(--ui-color-base-1) antialiased' }"
    >
      <slot />
    </B24DashboardGroup>
  </B24App>
</template>
