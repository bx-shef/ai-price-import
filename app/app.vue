<script setup lang="ts">
// Root component (not a page): global head/SEO. Pages render via NuxtPage.
useHead({
  htmlAttrs: { lang: 'ru' },
  title: 'Импорт документов в Bitrix24'
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
