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

// Public marketing landing (etap 4, functional pass — branded shell is later polish).
useHead({ title: LANDING_TITLE })
const year = copyrightYears(2026, 2026)
</script>

<template>
  <main class="min-h-screen bg-white text-gray-900">
    <!-- Hero -->
    <section class="mx-auto max-w-4xl px-6 pt-20 pb-14 text-center">
      <span class="inline-block rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-600">
        Приложение для Bitrix24
      </span>
      <h1 class="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">
        {{ LANDING_TITLE }}
      </h1>
      <p class="mx-auto mt-4 max-w-2xl text-lg text-gray-600">
        {{ LANDING_SUBTITLE }}
      </p>
      <div class="mt-8">
        <NuxtLink
          to="/app"
          class="inline-block rounded-xl bg-blue-600 px-6 py-3 text-base font-medium text-white transition-colors hover:bg-blue-700"
        >
          {{ LANDING_CTA }}
        </NuxtLink>
      </div>
    </section>

    <!-- How it works -->
    <section class="border-t border-gray-100 bg-gray-50 py-16">
      <div class="mx-auto max-w-4xl px-6">
        <h2 class="mb-10 text-center text-2xl font-semibold">
          Как это работает
        </h2>
        <div class="grid gap-6 sm:grid-cols-3">
          <div
            v-for="s in LANDING_STEPS"
            :key="s.n"
            class="rounded-2xl border border-gray-200 bg-white p-6"
          >
            <div class="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white">
              {{ s.n }}
            </div>
            <h3 class="mt-4 font-semibold">
              {{ s.title }}
            </h3>
            <p class="mt-1 text-sm text-gray-600">
              {{ s.text }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- Why us -->
    <section class="py-16">
      <div class="mx-auto max-w-4xl px-6">
        <h2 class="mb-10 text-center text-2xl font-semibold">
          Почему мы
        </h2>
        <div class="grid gap-6 sm:grid-cols-2">
          <div
            v-for="f in LANDING_FEATURES"
            :key="f.title"
            class="rounded-2xl border border-gray-200 p-6"
          >
            <h3 class="font-semibold text-blue-700">
              {{ f.title }}
            </h3>
            <p class="mt-1 text-sm text-gray-600">
              {{ f.text }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- CTA + footer -->
    <section class="border-t border-gray-100 bg-gray-50 py-14 text-center">
      <div class="mx-auto max-w-4xl px-6">
        <h2 class="text-2xl font-semibold">
          Импортируйте первый документ за минуту
        </h2>
        <div class="mt-6">
          <NuxtLink
            to="/app"
            class="inline-block rounded-xl bg-blue-600 px-6 py-3 text-base font-medium text-white transition-colors hover:bg-blue-700"
          >
            {{ LANDING_CTA }}
          </NuxtLink>
        </div>
        <p class="mt-10 text-xs text-gray-400">
          © {{ year }} · {{ LANDING_PUBLISHER }}
        </p>
      </div>
    </section>
  </main>
</template>
