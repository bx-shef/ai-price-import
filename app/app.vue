<script setup lang="ts">
import { LANDING_TITLE, LANDING_DESCRIPTION, ogImageUrl } from '~/utils/landing'

// Root component (not a page): global head/SEO incl. Open Graph / Twitter card.
// og:image must be absolute for scrapers; siteUrl comes from NUXT_PUBLIC_SITE_URL in
// prod (empty in dev → a relative /og.png, fine for local preview). Pages render via
// NuxtPage; the public landing forces its own dark shell.
const ogImage = ogImageUrl(useRuntimeConfig().public.siteUrl || '')

useHead({
  htmlAttrs: { lang: 'ru' },
  link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }]
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
