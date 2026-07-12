<script setup lang="ts">
import {
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

// Owner's business card (L2/L4): opened from the header «Визитка» button and the
// hero photo; rendered once here as a fixed overlay.
const cardOpen = ref(false)
</script>

<template>
  <div>
    <LandingHeader @open-card="cardOpen = true" />
    <BusinessCardModal
      :open="cardOpen"
      @close="cardOpen = false"
    />

    <main
      id="top"
      class="landing-root relative min-h-screen bg-[#05010f] text-slate-200"
    >
      <!-- radial brand glow — clip the off-screen blurred blobs HERE (not on <main>),
         so <main> has no overflow-hidden that would break the sticky LandingHeader. -->
      <div
        class="pointer-events-none absolute inset-0 overflow-hidden"
        aria-hidden="true"
      >
        <div class="absolute left-1/2 top-[-10%] h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-cyan-500/20 blur-[120px]" />
        <div class="absolute right-[-5%] top-[30%] h-[380px] w-[380px] rounded-full bg-indigo-500/15 blur-[110px]" />
      </div>

      <div class="relative">
        <!-- Hero -->
        <section class="relative mx-auto max-w-4xl px-6 pt-24 pb-16 text-center">
          <div class="pointer-events-none absolute inset-0 opacity-60">
            <ClientOnly>
              <HeroDocMagnet />
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

            <!-- Author photo (L4) → opens the business card (L2) -->
            <button
              type="button"
              class="mx-auto mt-9 flex w-fit items-center gap-3 rounded-full border border-white/10 bg-white/[0.03] py-1.5 pr-5 pl-1.5 text-left transition hover:border-cyan-400/40 hover:bg-white/[0.06]"
              aria-label="Открыть визитку автора"
              @click="cardOpen = true"
            >
              <img
                src="/igor.jpg"
                alt="Игорь Шевчик"
                width="44"
                height="44"
                class="h-11 w-11 rounded-full object-cover ring-1 ring-white/15"
              >
              <span class="leading-tight">
                <span class="block text-sm font-medium text-white">Игорь Шевчик</span>
                <span class="block text-xs text-slate-400">Издатель · открыть визитку</span>
              </span>
            </button>
          </div>
        </section>

        <!-- Live demo: attach a file → parsed supplier + goods -->
        <section
          id="demo"
          class="mx-auto max-w-4xl px-6 py-14 scroll-mt-16"
        >
          <h2 class="mb-3 text-center text-2xl font-semibold text-white">
            Попробуйте прямо сейчас
          </h2>
          <p class="mx-auto mb-8 max-w-2xl text-center text-sm text-slate-400">
            Прикрепите КП, счёт или ТТН — покажем, что распознаём: подрядчика и таблицу товаров.
            Демо разбирает документ и ничего не записывает.
          </p>
          <ClientOnly>
            <DemoTryout />
          </ClientOnly>

          <!-- Custom-dev banner -->
          <div class="mx-auto mt-10 max-w-3xl rounded-2xl border border-cyan-400/20 bg-gradient-to-r from-cyan-500/10 to-indigo-500/10 p-6 text-center">
            <p class="text-slate-200">
              Нужно под ваш процесс — свои поля, свои сущности, свой источник?
              <span class="font-semibold text-white">Доработаем и развернём на ваших серверах.</span>
            </p>
            <p class="mt-1 text-sm text-slate-400">
              {{ LANDING_PUBLISHER }} — Bitrix24-партнёр.
            </p>
          </div>
        </section>

        <!-- How it works -->
        <section
          id="how"
          class="mx-auto max-w-4xl px-6 py-14 scroll-mt-16"
        >
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
        <section
          id="why"
          class="mx-auto max-w-4xl px-6 py-14 scroll-mt-16"
        >
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
        </section>

        <!-- Footer (rich, ported from client-bank): legal + links + build + free tools -->
        <footer class="mx-auto max-w-4xl border-t border-white/10 px-6 py-8">
          <div class="flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-center">
            <SiteFooter />
            <a
              href="https://github.com/IgorShevchik"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub"
              class="shrink-0 text-white/40 transition hover:text-white"
            >
              <svg
                class="h-6 w-6"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.2 11.39.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.34-5.47-5.96 0-1.32.47-2.4 1.24-3.25-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.24a11.5 11.5 0 0 1 6 0c2.29-1.56 3.3-1.24 3.3-1.24.66 1.66.25 2.88.12 3.18.77.85 1.24 1.93 1.24 3.25 0 4.63-2.81 5.65-5.49 5.95.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z" />
              </svg>
            </a>
          </div>
        </footer>
      </div>
    </main>
  </div>
</template>
