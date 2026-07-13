<script setup lang="ts">
import { currencySymbol } from '~/utils/demoExtract'

// Renders a currency glyph for the demo. RUB/KZT/… have a Unicode sign (₽/₸) shown as
// text. The Belarusian ruble (BYN) has NO Unicode codepoint — its official sign (НБ РБ)
// is the letter «Б» with a horizontal bar crossing the left stem and protruding left
// (NOT a strike-through of the whole letter). We draw it as an inline SVG so it matches
// the regulator glyph at any size/colour, paired with a visually-hidden but selectable
// «Br» so screen readers announce it and copy/paste yields real text.
defineProps<{ code?: string }>()
</script>

<template>
  <span
    v-if="code === 'BYN'"
    class="byn-wrap"
  >
    <svg
      class="byn-sign"
      viewBox="0 0 22 26"
      fill="none"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <!-- Б: left stem + top arm + lower bowl -->
      <path d="M7 3.5 V22" />
      <path d="M7 3.5 H15" />
      <path d="M7 12.3 H12 C16.2 12.3 16.2 22 12 22 H7" />
      <!-- currency crossbar: crosses the stem and protrudes to the left -->
      <path d="M3 16.6 H10.6" />
    </svg><span class="byn-br">Br</span>
  </span>
  <span v-else-if="code">{{ currencySymbol(code) }}</span>
</template>

<style scoped>
.byn-sign {
  display: inline-block;
  height: 1em;
  width: auto;
  vertical-align: -0.13em;
}
/* Visually hidden but present for screen readers and copy/paste (the SVG carries the
   visual, this carries the text «Br»). */
.byn-br {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
