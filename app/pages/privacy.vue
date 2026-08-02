<script setup lang="ts">
// Политика конфиденциальности (#297). Источник — `docs/privacy-policy.md`; см. комментарий в
// `eula.vue` о том, почему страница рендерит файл, а не повторяет его.
import source from '~~/docs/privacy-policy.md?raw'
</script>

<template>
  <LegalDocument
    :source="source"
    title="Политика конфиденциальности"
    path="/privacy"
    description="Какие данные обрабатывает приложение «AI-импорт прайсов в Bitrix24», куда они передаются и сколько хранятся."
  />
</template>
