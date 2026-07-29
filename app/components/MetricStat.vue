<script setup lang="ts">
// One big number with its caption — the «Сэкономлено времени / денег» stat used on BOTH /app (the
// compact «Экономия» card) and /metrics (the detailed page). Extracted because the same markup was
// copy-pasted in two places and had already drifted apart (different font sizes, caption above vs
// below, tinted box vs plain) — the two screens of the SAME feature must read as one thing
// (docs/ui-spec.md §2.7 and §4).
//
// Caption goes ABOVE the value (approved design): the eye lands on the label first and the big number
// second, so a row of stats scans as a list rather than as loose numbers.
defineProps<{
  /** Small caps caption, e.g. «Сэкономлено времени». */
  label: string
  /** Formatted value, e.g. «11 ч 20 мин». Pass an em dash while data is loading. */
  value: string
  /** `page` — the standalone /metrics variant: framed box, larger type. Default is the inline
   *  variant used inside the /app card. */
  variant?: 'inline' | 'page'
}>()
</script>

<template>
  <div
    class="flex flex-col gap-0.5"
    :class="variant === 'page'
      ? 'flex-1 basis-64 rounded-xl border border-(--ui-color-base-5) bg-(--ui-color-base-7) p-5'
      : ''"
  >
    <span class="text-xs uppercase tracking-wide text-(--ui-color-base-4)">
      {{ label }}
    </span>
    <span
      class="font-semibold tracking-tight tabular-nums"
      :class="variant === 'page' ? 'text-4xl' : 'text-3xl'"
    >
      {{ value }}
    </span>
  </div>
</template>
