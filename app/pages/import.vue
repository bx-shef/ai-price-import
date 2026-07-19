<script setup lang="ts">
import { onMounted } from 'vue'

// Legacy route: document upload was merged into the action-first home page (/app owner decision).
// Kept as a redirect so old bookmarks / the marketplace handler URL don't 404. Prerendered shell;
// the redirect runs client-side (static host has no server redirect).
definePageMeta({ layout: 'clear' })
useHead({ title: 'Импорт документов', meta: [{ name: 'robots', content: 'noindex' }] })

const router = useRouter()
onMounted(() => {
  void router.replace('/app')
})
</script>

<template>
  <div class="mx-auto max-w-2xl p-6 text-center text-sm text-(--ui-color-base-3)">
    Переходим к загрузке документов…
  </div>
</template>
