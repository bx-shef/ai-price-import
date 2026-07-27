<script setup lang="ts">
import CloudIcon from '@bitrix24/b24icons-vue/outline/CloudIcon'
import { useRuntimeConfig } from '#app'
import { useMetrikaGoal } from '~/composables/useMetrikaGoal'

// Marketing widget on /app — built on b24ui B24Card variant="filled-copilot" (the «Sales dynamics
// widget» pattern from the b24ui Card docs: header slot with title/description, footer slot with a pill
// button). Pitches the paid custom-integration angle: pull the price list from the client's own sources
// (e-mail / Telegram / FTP) AND run the app on their server. Honest per docs/redesign/11 (text still
// goes to the LLM provider).
//
// CTA → OUR landing's brief form (`${siteUrl}/#brief`), not the separate offer site — owner asked the
// app's «Обсудить» to lead to the landing. `siteUrl` is the app's public URL (NUXT_PUBLIC_SITE_URL);
// UTM (before the #hash) makes the click measurable on the landing. In-portal Metrika self-disables, so
// reachGoal() is a no-op here — the UTM is the real attribution.
const siteUrl = (useRuntimeConfig().public.siteUrl as string || '').replace(/\/+$/, '')
const BRIEF_URL = `${siteUrl}/?utm_source=b24app&utm_medium=app_promo#brief`
const { reachGoal } = useMetrikaGoal()
</script>

<template>
  <B24Card
    variant="filled-copilot"
    class="mt-4"
  >
    <template #header>
      <div class="flex items-start gap-3">
        <CloudIcon
          class="mt-0.5 size-6 shrink-0 opacity-90"
          aria-hidden="true"
        />
        <div class="min-w-0">
          <h2 class="text-base font-semibold sm:text-lg">
            Прайс — сам, из ваших источников
          </h2>
          <p class="mt-1 text-sm opacity-90 sm:text-base">
            Заберём прайсы автоматически из почты, Telegram, по FTP или из другого источника и развернём
            приложение на вашем сервере — обработка без общей очереди. Индивидуальная доработка под ваш контур.
          </p>
        </div>
      </div>
    </template>

    <p class="text-xs opacity-70 sm:text-sm">
      Текст документа при этом всё равно уходит на LLM-провайдера; полностью локальный контур — отдельный разговор.
    </p>

    <template #footer>
      <B24Button
        label="Обсудить"
        :href="BRIEF_URL"
        target="_blank"
        rel="noopener noreferrer"
        color="air-secondary-accent"
        size="md"
        rounded
        @click="() => reachGoal('app_promo_brief')"
      />
    </template>
  </B24Card>
</template>
