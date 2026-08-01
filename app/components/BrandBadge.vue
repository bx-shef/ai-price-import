<script setup lang="ts">
// Pill badge of the dark vibecode landing: a cyan brand word plus a small uppercase caption.
// Extracted from PartnerBadge so the market-promo block can wear the SAME chrome instead of a
// second, slightly-off copy — one place to change, no drift between the two badges.
//
// Renders an <a> only when `href` is given: the partner badge links out, the promo badge is a
// label inside a card that already has its own call to action, and a nested link would be both
// invalid markup and a second tab target on the same click area.
defineProps<{
  /** Brand word, rendered in the accent colour (e.g. «Bitrix24»). */
  brand: string
  /** Small uppercase caption next to it (e.g. «Партнёр»). */
  caption: string
  /** Optional link target — omit for a purely decorative badge. */
  href?: string
  /** Accessible label; only meaningful together with `href`. */
  ariaLabel?: string
}>()
</script>

<template>
  <component
    :is="href ? 'a' : 'span'"
    :href="href"
    :target="href ? '_blank' : undefined"
    :rel="href ? 'noopener noreferrer' : undefined"
    :aria-label="href ? ariaLabel : undefined"
    class="inline-flex items-center gap-2 rounded-md border border-cyan-400/40 bg-cyan-400/10 px-3 py-1.5"
    :class="href ? 'transition hover:bg-cyan-400/20' : ''"
  >
    <span class="text-[14px] font-bold leading-none text-cyan-300">{{ brand }}</span>
    <span class="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/70">{{ caption }}</span>
  </component>
</template>
