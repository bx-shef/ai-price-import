<script setup lang="ts">
import { ref } from 'vue'
import { LANDING_CTA_MARKET, LANDING_MARKET_URL } from '~/utils/landing'

// Sticky landing navigation (L3, enriched to client-bank parity): section anchors +
// market / legal / operators links, a business-card trigger (L2), and a persistent
// «open app» CTA. Full menu on desktop; a hamburger drawer on mobile. Dark vibecode
// shell — landing only. `openCard` opens the owner's BusinessCardModal (owned by the page).
const emit = defineEmits<{ openCard: [] }>()

interface NavItem { label: string, to: string, external?: boolean, route?: boolean }
const NAV: NavItem[] = [
  { label: 'Демо', to: '#demo' },
  { label: 'Как это работает', to: '#how' },
  { label: 'Почему мы', to: '#why' },
  { label: 'Реквизиты', to: 'https://offer.bx-shef.by/legal', external: true },
  { label: 'Операторам', to: '/login', route: true }
]

const mobileOpen = ref(false)
function closeMobile() {
  mobileOpen.value = false
}
function openCardMobile() {
  mobileOpen.value = false
  emit('openCard')
}
</script>

<template>
  <header class="sticky top-0 z-30 border-b border-white/5 bg-[#05010f]/85 backdrop-blur">
    <div class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
      <a
        href="#top"
        class="shrink-0 text-lg font-bold tracking-tight text-white"
        aria-label="AI-импорт документов в Bitrix24 — наверх"
      >
        <span class="text-cyan-400">AI</span>-импорт
      </a>

      <!-- Desktop menu -->
      <nav
        class="hidden items-center gap-5 lg:flex"
        aria-label="Меню лендинга"
      >
        <template
          v-for="n in NAV"
          :key="n.label"
        >
          <NuxtLink
            v-if="n.route"
            :to="n.to"
            class="text-sm text-slate-300 transition hover:text-white"
          >{{ n.label }}</NuxtLink>
          <a
            v-else
            :href="n.to"
            :target="n.external ? '_blank' : undefined"
            :rel="n.external ? 'noopener noreferrer' : undefined"
            class="text-sm text-slate-300 transition hover:text-white"
          >{{ n.label }}</a>
        </template>
        <button
          type="button"
          class="text-sm text-slate-300 transition hover:text-white"
          @click="emit('openCard')"
        >
          Визитка
        </button>
      </nav>

      <div class="flex items-center gap-2">
        <!-- Full CTA on ≥sm; a compact label on phones so the row never overflows -->
        <a
          :href="LANDING_MARKET_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="shrink-0 rounded-lg bg-cyan-500 px-3 py-1.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 sm:px-4"
        >
          <span class="hidden sm:inline">{{ LANDING_CTA_MARKET }}</span>
          <span class="sm:hidden">В Маркет</span>
        </a>
        <!-- Mobile hamburger -->
        <button
          type="button"
          class="rounded-lg p-2 text-slate-300 transition hover:text-white lg:hidden"
          :aria-expanded="mobileOpen"
          aria-controls="landing-mobile-menu"
          aria-label="Меню"
          @click="mobileOpen = !mobileOpen"
        >
          <svg
            class="h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <path
              v-if="!mobileOpen"
              d="M4 6h16M4 12h16M4 18h16"
            />
            <path
              v-else
              d="M6 6l12 12M6 18L18 6"
            />
          </svg>
        </button>
      </div>
    </div>

    <!-- Mobile drawer -->
    <nav
      v-if="mobileOpen"
      id="landing-mobile-menu"
      class="border-t border-white/5 bg-[#05010f]/95 px-6 py-3 lg:hidden"
      aria-label="Меню лендинга (мобильное)"
    >
      <ul class="flex flex-col gap-1">
        <li
          v-for="n in NAV"
          :key="n.label"
        >
          <NuxtLink
            v-if="n.route"
            :to="n.to"
            class="block rounded-md px-2 py-2 text-sm text-slate-200 transition hover:bg-white/5 hover:text-white"
            @click="closeMobile"
          >{{ n.label }}</NuxtLink>
          <a
            v-else
            :href="n.to"
            :target="n.external ? '_blank' : undefined"
            :rel="n.external ? 'noopener noreferrer' : undefined"
            class="block rounded-md px-2 py-2 text-sm text-slate-200 transition hover:bg-white/5 hover:text-white"
            @click="closeMobile"
          >{{ n.label }}</a>
        </li>
        <li>
          <button
            type="button"
            class="block w-full rounded-md px-2 py-2 text-left text-sm text-slate-200 transition hover:bg-white/5 hover:text-white"
            @click="openCardMobile"
          >
            Визитка
          </button>
        </li>
      </ul>
    </nav>
  </header>
</template>
