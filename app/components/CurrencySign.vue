<script setup lang="ts">
import { currencySymbol } from '~/utils/demoExtract'

// Renders a currency glyph for the demo. RUB/KZT/… have a Unicode sign (₽/₸) shown as
// text. The Belarusian ruble (BYN) has NO Unicode codepoint — its sign is the letter «Б»
// with a horizontal bar — so we compose it: the font's «Б» + a CSS bar (inherits the
// current text colour/size, scales cleanly, no external font). Falls back to «Br» text
// for copy/paste and screen readers via aria-label.
defineProps<{ code?: string }>()
</script>

<template>
  <span
    v-if="code === 'BYN'"
    class="byn-sign"
    role="img"
    aria-label="белорусских рублей"
    title="белорусский рубль (Br)"
  >Б</span>
  <span v-else-if="code">{{ currencySymbol(code) }}</span>
</template>

<style scoped>
.byn-sign {
  position: relative;
  display: inline-block;
  font-weight: 600;
  /* keep the bar clear of neighbouring text */
  padding-inline: 0.04em;
}
.byn-sign::after {
  content: '';
  position: absolute;
  left: -6%;
  right: -6%;
  top: 54%;
  height: 0.09em;
  background: currentColor;
  border-radius: 1px;
  transform: translateY(-50%);
}
</style>
