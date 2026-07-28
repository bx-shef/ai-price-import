<script setup lang="ts">
import CrossMIcon from '@bitrix24/b24icons-vue/outline/CrossMIcon'

// Shared chrome for the two slider-opened pages (/settings and /metrics) so they look identical:
// a STICKY bar with a close control on the left and the page title next to it, on the muted surface
// (approved design, docs/redesign/14-ui-spec §3–4). Extracted instead of duplicating the markup in
// both pages — the two screens drifted apart before (one had a back-button above an h1, the other a
// text link on the right).
//
// Chrome ONLY: how the view actually closes (slider overlay vs in-frame navigation vs standalone)
// stays in the page — this component just emits `close`.
defineProps<{
  title: string
  /** One-line explanation under the bar. Optional — omit for a bare title. */
  subtitle?: string
  /** Opened as a real B24 slider → the control reads «Закрыть»; in-frame → «К обзору». */
  isSlider?: boolean
}>()
defineEmits<{ close: [] }>()
</script>

<template>
  <div>
    <div
      class="sticky top-0 z-10 flex items-center gap-3 border-b border-(--ui-color-base-5) bg-(--ui-color-base-7) px-4 py-3 sm:px-6"
    >
      <B24Button
        :icon="CrossMIcon"
        color="air-tertiary-no-accent"
        size="xs"
        :aria-label="isSlider ? 'Закрыть' : 'Вернуться к обзору'"
        @click="$emit('close')"
      />
      <h1 class="min-w-0 truncate text-lg font-semibold">
        {{ title }}
      </h1>
    </div>
    <p
      v-if="subtitle"
      class="px-4 pt-4 text-sm text-(--ui-color-base-3) sm:px-6"
    >
      {{ subtitle }}
    </p>
  </div>
</template>
