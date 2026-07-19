<script setup lang="ts">
// Minimal in-portal shell — no site chrome, but inside <B24App> so b24ui components, useToast and
// the colour-mode tokens work correctly. Used by the in-portal Bitrix24 iframe pages (/install,
// /app, /settings, /import) and the standalone operator pages (/login, /queues), so they theme
// (light/dark) with the portal / OS instead of being locked to a white surface.
import { ru } from '@bitrix24/b24ui-nuxt/locale'
</script>

<template>
  <B24App :locale="ru">
    <div class="min-h-screen w-full overflow-x-hidden bg-(--ui-color-bg-content-primary) text-(--ui-color-base-1) antialiased">
      <slot />
    </div>
  </B24App>
</template>
