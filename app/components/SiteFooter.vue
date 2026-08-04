<script setup lang="ts">
import { computed } from 'vue'
import { PUBLISHER } from '~/config/publisher'
import { shortSha, commitUrl } from '~/utils/build'
import { copyrightYears } from '~/utils/landing'

// Rich landing footer (ported from client-bank / offer.bx-shef.by): publisher legal,
// contact + legal links, build sha, and cross-ecosystem free tools. Native HTML —
// styled for the dark vibecode landing. Same publisher across the ecosystem.
const { public: { commitSha } } = useRuntimeConfig()

// Requisites come from the ONE source (#297) — a local copy had already drifted in spelling.
const legal = {
  short: PUBLISHER.shortName,
  unp: PUBLISHER.unpLabel,
  email: PUBLISHER.email,
  city: PUBLISHER.city
}

interface ToolLink { id: string, label: string, href: string }
// Free mini-tools — trust hook, shared across the bx-shef ecosystem.
const tools: ToolLink[] = [
  { id: 'currency', label: 'Конвертер валют', href: 'https://currency-converter.bx-shef.by/' },
  { id: 'bbcode', label: 'BBCode ↔ Markdown', href: 'https://bx-shef.github.io/app-convert-bbocode-md/' }
]

const year = copyrightYears(2026, 2026)
const sha = computed(() => shortSha(commitSha as string))
const shaHref = computed(() => commitUrl(commitSha as string))
</script>

<template>
  <div class="flex flex-col gap-2 text-xs text-white/55">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
      <span>© {{ year }} {{ legal.short }}</span>
      <span class="font-mono">{{ legal.unp }}</span>
      <span>{{ legal.city }}</span>
    </div>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
      <a
        :href="`mailto:${legal.email}`"
        class="hover:text-white hover:underline"
      >{{ legal.email }}</a>
      <a
        href="https://offer.bx-shef.by/legal"
        target="_blank"
        rel="noopener noreferrer"
        class="hover:text-white hover:underline"
      >Реквизиты</a>
      <!-- Юридические документы ЭТОГО приложения (#297) — свои страницы, не соседского сайта:
           Маркет Bitrix24 требует постоянные адреса, и по ним должны лежать документы про него. -->
      <NuxtLink
        to="/eula"
        class="hover:text-white hover:underline"
      >
        Лицензионное соглашение
      </NuxtLink>
      <NuxtLink
        to="/privacy"
        class="hover:text-white hover:underline"
      >
        Политика конфиденциальности
      </NuxtLink>
      <!-- Документы САЙТА — вторая пара (пакет юриста 2026-08-08). Посетитель лендинга приложение
           не устанавливал, лицензией не связан, и его данные (демо-разбор, форма заявки) описывает
           не политика приложения, а своя. Поэтому в подвале стоят все четыре, а не две. -->
      <NuxtLink
        to="/site-terms"
        class="hover:text-white hover:underline"
      >
        Условия использования сайта
      </NuxtLink>
      <NuxtLink
        to="/site-privacy"
        class="hover:text-white hover:underline"
      >
        Конфиденциальность сайта
      </NuxtLink>
      <a
        :href="shaHref"
        target="_blank"
        rel="noopener noreferrer"
        class="font-mono text-white/30 hover:text-white hover:underline"
      >сборка {{ sha || 'dev' }}</a>
    </div>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
      <span class="font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">Бесплатные инструменты</span>
      <a
        v-for="t in tools"
        :key="t.id"
        :href="t.href"
        target="_blank"
        rel="noopener noreferrer"
        class="font-mono hover:text-white hover:underline"
      >{{ t.label }}</a>
    </div>
  </div>
</template>
