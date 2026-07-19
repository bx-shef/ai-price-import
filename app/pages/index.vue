<script setup lang="ts">
import {
  LANDING_CTA_BRIEF,
  LANDING_CTA_MARKET,
  LANDING_FEATURES,
  LANDING_FORMATS,
  LANDING_HERO_NOTE,
  LANDING_HOW_SUBTITLE,
  LANDING_INTEGRATORS,
  LANDING_MARKET_PROMO,
  LANDING_MARKET_URL,
  LANDING_PUBLISHER,
  LANDING_STEPS,
  LANDING_SUBTITLE,
  LANDING_WHY_SUBTITLE
} from '~/utils/landing'
import { B24_BOOKING_URL } from '~/utils/booking'

// Public marketing landing. Composition + look mirror the sibling client-bank
// landing (dark vibecode shell, mouse-glow cards, left-aligned section headers,
// two-column hero), reusing this project's blocks and content; accent stays cyan.
useHead({
  title: 'AI-импорт документов в Bitrix24',
  bodyAttrs: { class: 'bg-[#05010f]' },
  // The landing shell is hardcoded dark (vibecode hex) — pin dark so app.vue's theme-init keeps b24ui
  // components on dark tokens here regardless of the visitor's OS theme (in-portal pages stay auto).
  htmlAttrs: { 'data-force-dark': 'true' }
})

useCardGlow()
const { reachGoal } = useMetrikaGoal()
const cardOpen = ref(false)

// Desktop QR of the Marketplace listing. `qrcode` is lazy-imported on mount so the
// (~50KB) chunk stays off the eager landing bundle; mobile uses HoldRevealQr instead.
const marketQr = ref('')
onMounted(async () => {
  try {
    const QRCode = (await import('qrcode')).default
    marketQr.value = await QRCode.toDataURL(LANDING_MARKET_URL, {
      width: 208,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0a1220', light: '#ffffff' }
    })
  } catch {
    // QR stays '' → skeleton shown; non-critical.
  }
})
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
      <!-- radial brand glow (clip blurred blobs here, not on <main>, for the sticky header) -->
      <div
        class="pointer-events-none absolute inset-0 overflow-hidden"
        aria-hidden="true"
      >
        <div class="absolute left-1/2 top-[-10%] h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-cyan-500/20 blur-[120px]" />
        <div class="absolute right-[-5%] top-[30%] h-[380px] w-[380px] rounded-full bg-indigo-500/15 blur-[110px]" />
      </div>

      <div class="relative">
        <!-- HERO -->
        <section
          id="hero"
          class="relative overflow-hidden px-[22px] pb-[64px] pt-[80px] sm:pb-[96px] sm:pt-[120px] lg:px-8"
        >
          <div class="pointer-events-none absolute inset-0 opacity-60">
            <ClientOnly>
              <HeroParticles />
            </ClientOnly>
          </div>

          <div class="relative z-10 mx-auto max-w-[1080px]">
            <div class="flex flex-col gap-10 lg:flex-row lg:items-center lg:gap-12">
              <!-- Photo: first on mobile, right column on desktop -->
              <div class="order-first flex shrink-0 justify-start lg:order-last lg:justify-end">
                <button
                  type="button"
                  class="rounded-full transition hover:scale-[1.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                  aria-label="Открыть визитку автора"
                  @click="cardOpen = true"
                >
                  <img
                    src="/igor.jpg"
                    alt="Игорь Шевчик"
                    width="240"
                    height="240"
                    class="size-44 rounded-full object-cover shadow-[0_0_64px_rgba(34,211,238,0.20)] ring-2 ring-cyan-400/45 sm:size-52 lg:size-60"
                    loading="eager"
                  >
                </button>
              </div>

              <!-- Text -->
              <div class="flex flex-1 flex-col items-start gap-5 lg:max-w-[620px]">
                <PartnerBadge />

                <h1 class="text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-6xl lg:text-7xl">
                  AI-импорт документов в <span class="text-cyan-400">Bitrix24</span>
                </h1>

                <p class="max-w-[560px] text-lg leading-relaxed text-white/70 sm:text-xl">
                  {{ LANDING_SUBTITLE }}
                </p>

                <div class="flex flex-wrap items-center gap-3">
                  <a
                    href="#brief"
                    class="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-6 py-3 text-base font-semibold text-slate-950 shadow-lg shadow-cyan-500/25 transition hover:bg-cyan-400"
                    @click="reachGoal('cta_hero')"
                  >
                    {{ LANDING_CTA_BRIEF }}
                    <svg
                      class="h-5 w-5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      aria-hidden="true"
                    ><path d="M5 12h14m0 0l-6-6m6 6l-6 6" /></svg>
                  </a>
                  <a
                    :href="B24_BOOKING_URL"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center rounded-xl border border-white/15 px-6 py-3 text-base font-semibold text-white transition hover:border-cyan-400/50 hover:bg-white/5"
                    @click="reachGoal('booking_click')"
                  >
                    Назначить созвон
                  </a>
                  <a
                    :href="LANDING_MARKET_URL"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center rounded-xl px-6 py-3 text-base font-semibold text-white/70 transition hover:text-white"
                    @click="reachGoal('market_click')"
                  >
                    {{ LANDING_CTA_MARKET }}
                  </a>
                </div>

                <p class="text-sm text-white/50">
                  {{ LANDING_HERO_NOTE }}
                </p>
              </div>
            </div>

            <!-- Formats tech-string -->
            <div class="mt-12 flex flex-col items-start gap-3 sm:mt-16">
              <div class="font-mono text-xs uppercase tracking-[0.18em] text-white/40">
                Понимает форматы
              </div>
              <div class="flex flex-wrap items-center gap-x-6 gap-y-2 text-white/60 sm:gap-x-8">
                <template
                  v-for="(f, i) in LANDING_FORMATS"
                  :key="f"
                >
                  <span class="font-mono text-sm tracking-tight">{{ f }}</span>
                  <span
                    v-if="i < LANDING_FORMATS.length - 1"
                    class="size-1 rounded-full bg-white/20"
                  />
                </template>
              </div>
            </div>
          </div>
        </section>

        <!-- БОЛЬ → РЕЗУЛЬТАТ -->
        <section class="px-[22px] py-[56px] sm:py-[72px] lg:px-8">
          <div class="mx-auto grid max-w-[1080px] gap-5 md:grid-cols-2">
            <div
              data-glow-card
              class="rounded-2xl border border-white/10 bg-white/[0.03] p-7"
            >
              <div class="mb-3 font-mono text-xs uppercase tracking-[0.14em] text-white/45">
                Было
              </div>
              <p class="text-base leading-relaxed text-white/80 sm:text-lg">
                Позиции из счёта или накладной вбивают в CRM руками — по строке за раз.
                Ошибки в суммах и НДС, потерянные строки, часы на сверку.
              </p>
            </div>
            <div
              data-glow-card
              class="rounded-2xl border border-cyan-400/30 bg-cyan-400/[0.06] p-7"
            >
              <div class="mb-3 font-mono text-xs uppercase tracking-[0.14em] text-cyan-300">
                Стало
              </div>
              <p class="text-base leading-relaxed text-white/90 sm:text-lg">
                Загрузили документ — AI распознал контрагента и все позиции и создал
                сделку/счёт/КП с товарами 1-в-1. Сверять нечего.
              </p>
            </div>
          </div>
        </section>

        <!-- ЖИВОЕ ДЕМО — визуально выделенный блок -->
        <section
          id="demo"
          class="scroll-mt-16 px-[22px] py-[56px] sm:py-[72px] lg:px-8"
        >
          <!-- Card: vertical padding only on mobile (client-bank form parity) so the demo
               content (esp. the result) spans edge-to-edge; heading/copy carry their own px-4. -->
          <div class="mx-auto max-w-[1080px] rounded-3xl border border-cyan-400/20 bg-gradient-to-b from-cyan-500/[0.07] to-white/[0.02] py-6 shadow-[0_0_80px_rgba(34,211,238,0.06)] sm:p-10">
            <div class="mb-2 flex justify-center px-4 sm:px-0">
              <span class="inline-flex items-center gap-2 rounded-full border border-cyan-400/40 bg-cyan-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-cyan-300">
                <span class="relative flex size-2">
                  <span class="absolute inline-flex size-full animate-ping rounded-full bg-cyan-400/70" />
                  <span class="relative inline-flex size-2 rounded-full bg-cyan-400" />
                </span>
                Живое демо
              </span>
            </div>
            <h2 class="mb-3 px-4 text-center text-2xl font-bold text-white sm:px-0 sm:text-3xl">
              Попробуйте на своём документе
            </h2>
            <p class="mx-auto mb-8 max-w-2xl px-4 text-center text-sm text-white/60 sm:px-0">
              Прикрепите PDF, скан, Excel или Word — покажем, что распознаём: контрагента,
              таблицу товаров, суммы и НДС. Демо разбирает документ и ничего не сохраняет.
            </p>
            <ClientOnly>
              <DemoTryout />
            </ClientOnly>
          </div>
        </section>

        <!-- КАК ЭТО РАБОТАЕТ -->
        <section
          id="how"
          class="scroll-mt-16 px-[22px] py-[56px] sm:py-[72px] lg:px-8"
        >
          <div class="mx-auto max-w-[1080px]">
            <div class="mb-12 max-w-[720px] sm:mb-14">
              <h2 class="mb-4 text-3xl font-bold tracking-tight text-white sm:text-4xl">
                Как это работает
              </h2>
              <p class="text-lg text-white/65">
                {{ LANDING_HOW_SUBTITLE }}
              </p>
            </div>
            <div class="grid grid-cols-1 gap-5 sm:grid-cols-3">
              <div
                v-for="s in LANDING_STEPS"
                :key="s.n"
                data-glow-card
                class="rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition-colors hover:border-white/25"
              >
                <div class="font-mono text-3xl font-bold leading-none text-cyan-400">
                  {{ s.n }}
                </div>
                <div class="mt-3 text-lg font-bold text-white">
                  {{ s.title }}
                </div>
                <div class="mt-2 text-sm leading-relaxed text-white/60">
                  {{ s.text }}
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- ПОЧЕМУ МЫ -->
        <section
          id="why"
          class="scroll-mt-16 px-[22px] py-[56px] sm:py-[72px] lg:px-8"
        >
          <div class="mx-auto max-w-[1080px]">
            <div class="mb-12 max-w-[720px] sm:mb-14">
              <h2 class="mb-4 text-3xl font-bold tracking-tight text-white sm:text-4xl">
                Почему мы
              </h2>
              <p class="text-lg text-white/65">
                {{ LANDING_WHY_SUBTITLE }}
              </p>
            </div>
            <div class="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <div
                v-for="f in LANDING_FEATURES"
                :key="f.title"
                data-glow-card
                class="rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition-colors hover:border-white/25"
              >
                <h3 class="text-xl font-bold leading-tight text-white">
                  {{ f.title }}
                </h3>
                <p class="mt-2 text-sm leading-relaxed text-white/65 sm:text-base">
                  {{ f.text }}
                </p>
              </div>
            </div>
          </div>
        </section>

        <!-- ПРИЛОЖЕНИЕ В МАРКЕТЕ — бесплатная точка входа (вторичный вес) -->
        <section class="px-[22px] pb-[56px] pt-[8px] sm:pb-[72px] lg:px-8">
          <div class="mx-auto max-w-[600px]">
            <div
              data-glow-card
              class="relative overflow-hidden rounded-2xl border border-cyan-400/40 bg-cyan-400/[0.06] p-6 sm:p-7"
            >
              <div class="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                <div class="min-w-0">
                  <div class="mb-2 font-mono text-[11px] font-medium uppercase tracking-wide text-cyan-300/80">
                    {{ LANDING_MARKET_PROMO.eyebrow }}
                  </div>
                  <h2 class="mb-1.5 text-lg font-semibold text-white">
                    {{ LANDING_MARKET_PROMO.title }}
                  </h2>
                  <p class="mb-4 text-sm leading-relaxed text-white/65">
                    {{ LANDING_MARKET_PROMO.text }}
                  </p>
                  <a
                    :href="LANDING_MARKET_URL"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-2 rounded-lg border border-cyan-400/50 px-4 py-2 text-sm font-semibold text-cyan-200 transition hover:bg-cyan-400/10"
                    @click="reachGoal('market_card_click')"
                  >
                    {{ LANDING_MARKET_PROMO.cta }}
                    <svg
                      class="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      aria-hidden="true"
                    ><path d="M5 12h14m0 0l-6-6m6 6l-6 6" /></svg>
                  </a>
                </div>

                <!-- Desktop: a scannable QR of the Marketplace listing (open on a phone) -->
                <ClientOnly>
                  <div class="hidden shrink-0 flex-col items-center gap-1.5 sm:flex">
                    <div class="rounded-xl bg-white p-2.5 shadow-lg">
                      <img
                        v-if="marketQr"
                        :src="marketQr"
                        alt="QR-код: приложение в Маркете Bitrix24"
                        class="block size-[104px]"
                      >
                      <div
                        v-else
                        class="size-[104px] animate-pulse rounded bg-black/5"
                      />
                    </div>
                    <span class="font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">Сканируйте</span>
                  </div>
                </ClientOnly>
              </div>

              <!-- Mobile: hold-to-reveal QR (fingerprint), parity with client-bank -->
              <div class="mt-4 sm:hidden">
                <HoldRevealQr
                  :url="LANDING_MARKET_URL"
                  goal="market_qr_reveal"
                  caption="Маркет Bitrix24"
                  hint="QR Маркета"
                  dark
                />
              </div>
            </div>
          </div>
        </section>

        <!-- ИНТЕГРАТОРАМ -->
        <section class="px-[22px] py-[56px] sm:py-[72px] lg:px-8">
          <div class="mx-auto max-w-[1080px] rounded-3xl border border-white/10 bg-gradient-to-br from-indigo-500/[0.14] to-cyan-500/[0.07] p-8 sm:p-10">
            <h2 class="mb-4 text-2xl font-bold tracking-tight text-white sm:text-4xl">
              Интеграторам Bitrix24
            </h2>
            <p class="mb-6 max-w-3xl text-base leading-relaxed text-white/75 sm:text-lg">
              {{ LANDING_INTEGRATORS }}
            </p>
            <a
              href="#brief"
              class="inline-flex items-center gap-2 rounded-lg border border-white/15 px-5 py-2.5 text-sm font-semibold text-white transition hover:border-cyan-400/50 hover:bg-white/5"
              @click="reachGoal('partners_brief')"
            >
              Обсудить сотрудничество
              <svg
                class="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                aria-hidden="true"
              ><path d="M5 12h14m0 0l-6-6m6 6l-6 6" /></svg>
            </a>
          </div>
        </section>

        <!-- ФОРМА — «Обсудить индивидуальную интеграцию» -->
        <section
          id="brief"
          class="scroll-mt-16 px-[22px] py-[56px] sm:py-[80px] lg:px-8"
        >
          <!-- Card: only vertical padding on mobile so the embedded form spans edge-to-edge
               (client-bank parity); the heading/copy carry their own px-8, form stays full-width. -->
          <div class="mx-auto max-w-[900px] rounded-3xl border border-white/10 bg-gradient-to-br from-cyan-500/[0.10] to-indigo-500/[0.06] py-8 sm:p-12">
            <h2 class="mb-3 px-8 text-3xl font-bold tracking-tight text-white sm:px-0 sm:text-4xl">
              Обсудить индивидуальную интеграцию
            </h2>
            <p class="mb-8 px-8 text-lg text-white/70 sm:px-0">
              Свои поля, свои сущности, свой источник документов — доработаем и развернём
              под ваш процесс. Ответим в течение рабочего дня.
            </p>
            <BriefForm />
          </div>
        </section>

        <!-- Footer -->
        <footer class="mx-auto max-w-[1080px] border-t border-white/10 px-[22px] py-8 lg:px-8">
          <div class="flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-center">
            <SiteFooter />
            <a
              href="https://github.com/IgorShevchik"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub"
              class="text-white/40 transition hover:text-white"
            >
              <svg
                class="h-6 w-6"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              ><path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.5v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.7.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 016 0C17 4.6 18 4.9 18 4.9c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.6.8.5A11.5 11.5 0 0023.5 12C23.5 5.7 18.3.5 12 .5z" /></svg>
            </a>
          </div>
          <p class="mt-4 text-xs text-white/35">
            {{ LANDING_PUBLISHER }} — Bitrix24-партнёр.
          </p>
        </footer>
      </div>
    </main>

    <MobileBriefCta />
  </div>
</template>
