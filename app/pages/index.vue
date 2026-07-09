<script setup lang="ts">
import {
  copyrightYears,
  LANDING_CTA,
  LANDING_FEATURES,
  LANDING_PUBLISHER,
  LANDING_STEPS,
  LANDING_SUBTITLE,
  LANDING_TITLE
} from '~/utils/landing'

// Public marketing landing (etap 4). Dark brand shell (vibecode palette) — the
// public face; in-portal pages keep their own light theme.
useHead({
  title: LANDING_TITLE,
  bodyAttrs: { class: 'bg-[#05010f]' }
})
const year = copyrightYears(2026, 2026)
</script>

<template>
  <main class="landing-root relative min-h-screen overflow-hidden bg-[#05010f] text-slate-200">
    <!-- radial brand glow -->
    <div
      class="pointer-events-none absolute inset-0"
      aria-hidden="true"
    >
      <div class="absolute left-1/2 top-[-10%] h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-cyan-500/20 blur-[120px]" />
      <div class="absolute right-[-5%] top-[30%] h-[380px] w-[380px] rounded-full bg-indigo-500/15 blur-[110px]" />
    </div>

    <div class="relative">
      <!-- Hero -->
      <section class="relative mx-auto max-w-4xl px-6 pt-24 pb-16 text-center">
        <div class="pointer-events-none absolute inset-0 opacity-50">
          <ClientOnly>
            <HeroGraph />
          </ClientOnly>
        </div>
        <div class="relative z-10">
          <span class="inline-block rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-xs font-medium text-cyan-300">
            Приложение для Bitrix24
          </span>
          <h1 class="mt-5 bg-gradient-to-b from-white to-slate-300 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
            {{ LANDING_TITLE }}
          </h1>
          <p class="mx-auto mt-5 max-w-2xl text-lg text-slate-400">
            {{ LANDING_SUBTITLE }}
          </p>
          <div class="mt-9">
            <NuxtLink
              to="/app"
              class="inline-block rounded-xl bg-cyan-500 px-6 py-3 text-base font-semibold text-slate-950 shadow-lg shadow-cyan-500/25 transition hover:bg-cyan-400"
            >
              {{ LANDING_CTA }}
            </NuxtLink>
          </div>
        </div>
      </section>

      <!-- How it works -->
      <section class="mx-auto max-w-4xl px-6 py-14">
        <h2 class="mb-10 text-center text-2xl font-semibold text-white">
          Как это работает
        </h2>
        <div class="grid gap-5 sm:grid-cols-3">
          <div
            v-for="s in LANDING_STEPS"
            :key="s.n"
            class="rounded-2xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur"
          >
            <div class="flex h-9 w-9 items-center justify-center rounded-full bg-cyan-500/15 text-sm font-semibold text-cyan-300 ring-1 ring-cyan-400/30">
              {{ s.n }}
            </div>
            <h3 class="mt-4 font-semibold text-white">
              {{ s.title }}
            </h3>
            <p class="mt-1.5 text-sm text-slate-400">
              {{ s.text }}
            </p>
          </div>
        </div>
      </section>

      <!-- Why us -->
      <section class="mx-auto max-w-4xl px-6 py-14">
        <h2 class="mb-10 text-center text-2xl font-semibold text-white">
          Почему мы
        </h2>
        <div class="grid gap-5 sm:grid-cols-2">
          <div
            v-for="f in LANDING_FEATURES"
            :key="f.title"
            class="rounded-2xl border border-white/10 bg-white/[0.03] p-6"
          >
            <h3 class="font-semibold text-cyan-300">
              {{ f.title }}
            </h3>
            <p class="mt-1.5 text-sm text-slate-400">
              {{ f.text }}
            </p>
          </div>
        </div>
      </section>

      <!-- CTA + footer -->
      <section class="mx-auto max-w-4xl px-6 py-16 text-center">
        <h2 class="text-2xl font-semibold text-white">
          Импортируйте первый документ за минуту
        </h2>
        <div class="mt-7">
          <NuxtLink
            to="/app"
            class="inline-block rounded-xl bg-cyan-500 px-6 py-3 text-base font-semibold text-slate-950 shadow-lg shadow-cyan-500/25 transition hover:bg-cyan-400"
          >
            {{ LANDING_CTA }}
          </NuxtLink>
        </div>
        <p class="mt-12 text-xs text-slate-500">
          © {{ year }} · {{ LANDING_PUBLISHER }}
        </p>
      </section>
    </div>
  </main>
</template>
