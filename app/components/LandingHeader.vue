<script setup lang="ts">
import { LANDING_CTA } from '~/utils/landing'

// Sticky landing navigation (L3). Asset-free text wordmark + section anchors + a
// persistent "open app" CTA. Dark brand shell (vibecode) — landing only; in-portal
// pages keep their own chrome. Anchor targets carry scroll-mt so they clear the bar.
// `openCard` opens the owner's BusinessCardModal (L2), owned by the page.
const emit = defineEmits<{ openCard: [] }>()
const NAV = [
  { href: '#demo', label: 'Демо' },
  { href: '#how', label: 'Как это работает' },
  { href: '#why', label: 'Почему мы' }
]
</script>

<template>
  <header class="sticky top-0 z-30 border-b border-white/5 bg-[#05010f]/85 backdrop-blur">
    <div class="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
      <a
        href="#top"
        class="text-lg font-bold tracking-tight text-white"
        aria-label="AI-импорт документов в Bitrix24 — наверх"
      >
        <span class="text-cyan-400">AI</span>-импорт
      </a>
      <nav
        class="hidden items-center gap-6 sm:flex"
        aria-label="Разделы страницы"
      >
        <a
          v-for="n in NAV"
          :key="n.href"
          :href="n.href"
          class="text-sm text-slate-300 transition hover:text-white"
        >{{ n.label }}</a>
        <button
          type="button"
          class="text-sm text-slate-300 transition hover:text-white"
          @click="emit('openCard')"
        >
          Визитка
        </button>
      </nav>
      <NuxtLink
        to="/app"
        class="shrink-0 rounded-lg bg-cyan-500 px-4 py-1.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
      >
        {{ LANDING_CTA }}
      </NuxtLink>
    </div>
  </header>
</template>
