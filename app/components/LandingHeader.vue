<script setup lang="ts">
import { ref, type Component } from 'vue'
import MagicWandIcon from '@bitrix24/b24icons-vue/solid/MagicWandIcon'
import OpenBookIcon from '@bitrix24/b24icons-vue/main/OpenBookIcon'
import ShieldIcon from '@bitrix24/b24icons-vue/solid/ShieldIcon'
import ReceiptIcon from '@bitrix24/b24icons-vue/outline/ReceiptIcon'
import LogInIcon from '@bitrix24/b24icons-vue/outline/LogInIcon'
import ContactDetailsIcon from '@bitrix24/b24icons-vue/outline/ContactDetailsIcon'
import { LANDING_CTA_MARKET, LANDING_MARKET_URL } from '~/utils/landing'

// Sticky landing navigation (client-bank parity): section anchors + market / legal /
// operators links with per-item icons, a business-card trigger and a persistent «open
// in Marketplace» CTA. Full menu on desktop; an icon-row drawer on mobile. Dark vibecode
// shell — landing only. `openCard` opens the owner's BusinessCardModal (owned by the page).
const emit = defineEmits<{ openCard: [] }>()

interface NavItem { label: string, to: string, icon: Component, external?: boolean, route?: boolean }
const NAV: NavItem[] = [
  { label: 'Демо', to: '#demo', icon: MagicWandIcon },
  { label: 'Как это работает', to: '#how', icon: OpenBookIcon },
  { label: 'Почему мы', to: '#why', icon: ShieldIcon },
  { label: 'Реквизиты', to: 'https://offer.bx-shef.by/legal', icon: ReceiptIcon, external: true },
  { label: 'Операторам', to: '/login', icon: LogInIcon, route: true }
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

      <!-- Desktop menu — icon + label per item -->
      <nav
        class="hidden items-center gap-1 xl:flex"
        aria-label="Меню лендинга"
      >
        <template
          v-for="n in NAV"
          :key="n.label"
        >
          <NuxtLink
            v-if="n.route"
            :to="n.to"
            class="flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-slate-300 transition hover:bg-white/5 hover:text-white"
          >
            <component
              :is="n.icon"
              class="size-4 text-cyan-300/70"
            />
            {{ n.label }}
          </NuxtLink>
          <a
            v-else
            :href="n.to"
            :target="n.external ? '_blank' : undefined"
            :rel="n.external ? 'noopener noreferrer' : undefined"
            class="flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-slate-300 transition hover:bg-white/5 hover:text-white"
          >
            <component
              :is="n.icon"
              class="size-4 text-cyan-300/70"
            />
            {{ n.label }}
          </a>
        </template>
        <button
          type="button"
          class="flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-slate-300 transition hover:bg-white/5 hover:text-white"
          @click="emit('openCard')"
        >
          <ContactDetailsIcon class="size-4 text-cyan-300/70" />
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
          class="rounded-lg p-2 text-slate-300 transition hover:text-white xl:hidden"
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

    <!-- Mobile drawer — icon-chip rows (client-bank look) -->
    <nav
      v-if="mobileOpen"
      id="landing-mobile-menu"
      class="border-t border-white/5 bg-[#05010f]/95 px-4 py-3 xl:hidden"
      aria-label="Меню лендинга (мобильное)"
    >
      <ul class="flex flex-col gap-0.5">
        <li
          v-for="n in NAV"
          :key="n.label"
        >
          <NuxtLink
            v-if="n.route"
            :to="n.to"
            class="flex items-center gap-3 rounded-xl px-2 py-2.5 text-sm text-slate-200 transition hover:bg-white/5 hover:text-white"
            @click="closeMobile"
          >
            <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-300">
              <component
                :is="n.icon"
                class="size-4"
              />
            </span>
            {{ n.label }}
          </NuxtLink>
          <a
            v-else
            :href="n.to"
            :target="n.external ? '_blank' : undefined"
            :rel="n.external ? 'noopener noreferrer' : undefined"
            class="flex items-center gap-3 rounded-xl px-2 py-2.5 text-sm text-slate-200 transition hover:bg-white/5 hover:text-white"
            @click="closeMobile"
          >
            <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-300">
              <component
                :is="n.icon"
                class="size-4"
              />
            </span>
            {{ n.label }}
          </a>
        </li>
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left text-sm text-slate-200 transition hover:bg-white/5 hover:text-white"
            @click="openCardMobile"
          >
            <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-300">
              <ContactDetailsIcon class="size-4" />
            </span>
            Визитка
          </button>
        </li>
      </ul>
    </nav>
  </header>
</template>
