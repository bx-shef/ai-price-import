<script setup lang="ts">
import { currencySymbol } from '~/utils/demoExtract'

// Renders a currency glyph for the demo. RUB/KZT/… have a Unicode sign (₽/₸) shown as
// text. The Belarusian ruble (BYN) has NO Unicode codepoint, so we embed the official
// National Bank of Belarus sign as an inline SVG (traced glyph, filled with currentColor
// so it inherits size/colour), paired with a visually-hidden but selectable «BYN» so
// screen readers announce it and copy/paste yields real text.
defineProps<{ code?: string }>()
</script>

<template>
  <span
    v-if="code === 'BYN'"
    class="byn-wrap"
  >
    <svg
      class="byn-sign"
      viewBox="0 0 700 700"
      fill="currentColor"
      aria-hidden="true"
    >
      <!-- Official National Bank of Belarus BYN sign (traced glyph). -->
      <g transform="translate(0,700) scale(0.1,-0.1)">
        <path d="M1758 4520 l-3 -2105 -462 -3 -463 -2 0 -305 0 -305 452 -2 452 -3 13 -25 c10 -19 13 -182 13 -733 l0 -708 1313 4 c1470 4 1447 3 1737 79 41 11 91 23 111 28 66 17 263 101 354 151 151 84 301 198 420 321 210 214 349 465 426 764 41 161 52 251 56 469 5 237 -14 388 -74 595 -19 65 -88 232 -113 275 -10 17 -28 48 -40 70 -135 245 -403 488 -701 636 -222 111 -445 173 -744 209 -147 18 -235 20 -1087 20 -829 0 -928 2 -942 16 -14 14 -16 119 -16 1010 0 619 4 1002 10 1013 9 18 70 18 1392 16 761 -2 1447 -1 1526 2 l142 6 0 306 0 306 -1885 0 -1885 0 -2 -2105z m2562 -1190 c242 -28 382 -66 555 -152 131 -66 195 -109 280 -190 123 -116 232 -288 283 -448 70 -218 67 -534 -8 -760 -117 -350 -394 -628 -760 -760 -46 -17 -140 -42 -209 -55 l-125 -25 -922 0 c-828 0 -924 2 -938 16 -14 14 -16 63 -14 427 l3 412 809 3 809 2 -7 46 c-3 26 -6 163 -6 305 l0 259 -789 0 c-704 0 -791 2 -805 16 -14 14 -16 69 -16 458 0 243 3 446 7 449 10 11 1758 8 1853 -3z" />
      </g>
    </svg><span class="byn-br">BYN</span>
  </span>
  <span v-else-if="code">{{ currencySymbol(code) }}</span>
</template>

<style scoped>
.byn-sign {
  display: inline-block;
  height: 0.92em;
  width: auto;
  vertical-align: -0.08em;
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
