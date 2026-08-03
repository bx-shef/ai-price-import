<script setup lang="ts">
import CloudIcon from '@bitrix24/b24icons-vue/outline/CloudIcon'
import { useRuntimeConfig } from '#app'
import { useMetrikaGoal } from '~/composables/useMetrikaGoal'
import { appBriefUrl } from '~/utils/landing'

// Marketing widget on /app — built on b24ui B24Card variant="filled-copilot" (the «Sales dynamics
// widget» pattern from the b24ui Card docs: header slot with title/description, footer slot with a pill
// button). Pitches the paid custom-integration angle: pull the price list from the client's own sources
// (e-mail / Telegram / FTP) AND run the app on their server. Honest per docs/PROJECT_MAP.md (text still
// goes to the LLM provider).
//
// CTA → OUR landing's brief form (`/#brief`), not the separate offer site — owner asked the app's
// «Обсудить» to lead to the landing. UTM (before the #hash) makes the click measurable there; in-portal
// Metrika self-disables, so reachGoal() is a no-op here and the UTM is the real attribution.
//
// The base goes through `siteBaseUrl` (#231). It used to be raw `NUXT_PUBLIC_SITE_URL`, and an unset or
// non-absolute value silently produced a RELATIVE link — which, inside the portal iframe, resolves
// against the CLIENT'S OWN domain: the button led to `https://<клиент>.bitrix24.by/?...#brief`, not to
// the landing. Nothing failed, it just went to the wrong place. Same trap as the canonical/og tags
// (#304), so the same rule: the landing has exactly one home, and a missing env falls back to it
// instead of degrading into a relative path.
const BRIEF_URL = appBriefUrl(useRuntimeConfig().public.siteUrl as string)
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
            Работа на вашем сервере — по запросу
          </h2>
          <p class="mt-1 text-sm opacity-90 sm:text-base">
            Заберём прайсы сами — из почты, Telegram, по FTP или другого источника — и настроим
            импорт под ваши документы. Это может работать и на вашем сервере, без общей очереди.
            Условия, сроки и цену назовём под вашу задачу — напишите нам.
          </p>
        </div>
      </div>
    </template>

    <p class="text-xs opacity-70 sm:text-sm">
      Важно: текст документа при этом всё равно уходит на разбор к поставщику языковой модели —
      свой сервер сам по себе не делает контур замкнутым. Полностью локальный разбор — отдельный
      разговор.
    </p>

    <template #footer>
      <B24Button
        label="Обсудить задачу"
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
