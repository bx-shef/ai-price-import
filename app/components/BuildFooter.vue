<script setup lang="ts">
import { computed } from 'vue'
import { shortSha, commitUrl } from '~/utils/build'

// Build-commit footer for in-portal pages («сборка <sha>» → GitHub commit) — lets support confirm
// which version a portal runs. Source = NUXT_PUBLIC_COMMIT_SHA (same as /api/health and the landing).
//
// ⚠ `bare` — та же подпись БЕЗ своей рамки и отступа сверху: на экранах, открытых слайдером, она
// живёт внутри нижней панели действий (#523), у которой уже есть и граница, и поверхность. Со своей
// рамкой получалась бы вторая черта под первой.
const { bare = false } = defineProps<{ bare?: boolean }>()
const { public: { commitSha } } = useRuntimeConfig()
const sha = computed(() => shortSha(commitSha as string))
const href = computed(() => commitUrl(commitSha as string))
</script>

<template>
  <div :class="bare ? '' : 'mt-8 border-t border-(--ui-color-base-5) pt-3 text-right'">
    <a
      :href="href"
      target="_blank"
      rel="noopener noreferrer"
      class="font-mono text-xs text-(--ui-color-base-4) hover:text-(--ui-color-accent-main-link) hover:underline"
    >сборка {{ sha || 'dev' }}</a>
  </div>
</template>
