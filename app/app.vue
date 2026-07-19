<script setup lang="ts">
import { LANDING_TITLE, LANDING_DESCRIPTION, ogImageUrl } from '~/utils/landing'

// Root component (not a page): global head/SEO incl. Open Graph / Twitter card.
// og:image must be absolute for scrapers; siteUrl comes from NUXT_PUBLIC_SITE_URL in
// prod (empty in dev → a relative /og.png, fine for local preview). Pages render via
// NuxtPage; the public landing forces its own dark shell.
const ogImage = ogImageUrl(useRuntimeConfig().public.siteUrl || '')

// b24ui colorMode (vueuse) persists the choice under this key; the inline theme-init script below
// reads it to set the .dark/.light class BEFORE first paint. Keep in sync with b24ui's default.
const COLOR_MODE_STORAGE_KEY = 'vueuse-color-scheme'

useHead({
  htmlAttrs: { lang: 'ru' },
  link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
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

useSeoMeta({
  title: LANDING_TITLE,
  description: LANDING_DESCRIPTION,
  ogTitle: LANDING_TITLE,
  ogDescription: LANDING_DESCRIPTION,
  ogType: 'website',
  ogImage,
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageType: 'image/png',
  ogImageAlt: LANDING_TITLE,
  twitterCard: 'summary_large_image',
  twitterTitle: LANDING_TITLE,
  twitterDescription: LANDING_DESCRIPTION,
  twitterImage: ogImage
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
