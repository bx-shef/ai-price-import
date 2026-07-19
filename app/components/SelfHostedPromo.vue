<script setup lang="ts">
import CloudIcon from '@bitrix24/b24icons-vue/outline/CloudIcon'
import { useMetrikaGoal } from '~/composables/useMetrikaGoal'

// Marketing banner on /app: the cloud plan is reliable but queues under load, so pitch the
// self-hosted («развернём на вашем сервере») offer to high-volume portals. Honest message per
// docs/redesign/11-pricing-selfhosted.md — no «за секунды», and the data caveat (text still goes
// to the LLM provider) is stated so we don't mislead. CTA → the offer site's brief.
const OFFER_BRIEF_URL = 'https://offer.bx-shef.by/#brief'
const { reachGoal } = useMetrikaGoal() // no-op inside the B24 iframe (Metrika self-disables there)
</script>

<template>
  <B24Card
    variant="tinted"
    class="mt-4"
  >
    <div class="flex items-start gap-3">
      <CloudIcon
        class="mt-0.5 size-5 shrink-0 text-(--ui-color-accent-main-primary)"
        aria-hidden="true"
      />
      <div class="min-w-0">
        <h2 class="text-sm font-semibold">
          Нужна скорость или сервер под вашим контролем?
        </h2>
        <p class="mt-1 text-xs text-(--ui-color-base-3)">
          Облако работает надёжно, но в пик документы встают в очередь. Для больших объёмов
          развернём приложение <b>на вашем сервере</b> — обработка параллельно, без соседей-арендаторов.
          Текст документа при этом всё равно уходит на LLM-провайдера; полностью локальный контур —
          отдельный разговор.
        </p>
        <B24Button
          label="Обсудить разворот на своём сервере"
          :href="OFFER_BRIEF_URL"
          target="_blank"
          rel="noopener noreferrer"
          color="air-primary"
          size="sm"
          class="mt-3"
          @click="() => reachGoal('selfhosted_brief')"
        />
      </div>
    </div>
  </B24Card>
</template>
