<script setup lang="ts">
// Root component (not a page): only head that belongs to EVERY page — lang, favicon, theme-init.
// Share/SEO meta (title/description/Open Graph/Twitter/canonical) lives in `pages/index.vue`, NOT
// here: this component wraps the in-portal and operator screens too, and a root-level useSeoMeta
// applied the landing's marketing OG to /app, /settings, /queues (verified in prod — /app served the
// landing's og:title). Pages render via NuxtPage; the public landing forces its own dark shell.

// b24ui colorMode (vueuse) persists the choice under this key; the inline theme-init script below
// reads it to set the .dark/.light class BEFORE first paint. Keep in sync with b24ui's default.
const COLOR_MODE_STORAGE_KEY = 'vueuse-color-scheme'

useHead({
  htmlAttrs: { lang: 'ru' },
  script: [{
    // FOUC guard for SSG: b24ui colorMode sets the class only on the client (after hydration), so we
    // apply the stored / OS theme before first paint. `auto` (nothing stored) → OS preference. The
    // public landing sets htmlAttrs `data-force-dark` (its shell is hardcoded dark) — honor it so this
    // script pins dark there instead of repainting to the OS theme; in-portal pages keep light/dark-auto.
    key: 'theme-init',
    tagPosition: 'head',
    innerHTML: `(function(){try{var el=document.documentElement,c=el.classList;if(el.getAttribute("data-force-dark")==="true"){c.add("dark");c.remove("light");return;}var s=localStorage.getItem("${COLOR_MODE_STORAGE_KEY}")||"auto";if(s==="auto"){s=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}var d=s!=="light";c.toggle("dark",d);c.toggle("light",!d);}catch(e){}})();`
  }]
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <!-- Уведомление о cookie (#404) живёт в КОРНЕ, а не в layout лендинга: юридические страницы
       своего layout не имеют, а показывать его надо и там. Решение «где показывать» — белый список
       адресов внутри компонента, поэтому во фрейме портала он не появится. -->
  <CookieBanner />
</template>
