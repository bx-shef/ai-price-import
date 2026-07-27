<script setup lang="ts">
import CloudIcon from '@bitrix24/b24icons-vue/outline/CloudIcon'
import { useRuntimeConfig } from '#app'
import { useMetrikaGoal } from '~/composables/useMetrikaGoal'

// Marketing callout on /app — rebuilt on the canonical b24ui B24Alert (native look, air-copilot promo
// colour) instead of a hand-styled tinted card. Pitches the paid custom-integration angle: pull the
// price list from the client's own sources (e-mail / Telegram / FTP) AND run the app on their server.
// Honest per docs/redesign/11-pricing-selfhosted.md (text still goes to the LLM provider).
//
// CTA → OUR landing's brief form (`${siteUrl}/#brief`), not the separate offer site — the owner asked
// the app's «Обсудить» to lead to the landing. `siteUrl` is the app's public URL (NUXT_PUBLIC_SITE_URL);
// UTM (before the #hash) makes the click measurable on the landing. In-portal Metrika self-disables, so
// reachGoal() is a no-op here — the UTM is the real attribution.
const siteUrl = (useRuntimeConfig().public.siteUrl as string || '').replace(/\/+$/, '')
const BRIEF_URL = `${siteUrl}/?utm_source=b24app&utm_medium=app_promo#brief`
const { reachGoal } = useMetrikaGoal()
</script>

<template>
  <B24Alert
    class="mt-4"
    color="air-primary-copilot"
    :icon="CloudIcon"
    title="Прайс — сам, из ваших источников"
    description="Заберём прайсы автоматически из почты, Telegram, по FTP или из другого источника и развернём приложение на вашем сервере — обработка без общей очереди. Индивидуальная доработка под ваш контур. (Текст документа при этом всё равно уходит на LLM-провайдера.)"
  >
    <template #actions>
      <B24Button
        label="Обсудить"
        :href="BRIEF_URL"
        target="_blank"
        rel="noopener noreferrer"
        color="air-primary"
        size="md"
        @click="() => reachGoal('app_promo_brief')"
      />
    </template>
  </B24Alert>
</template>
