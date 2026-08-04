<script setup lang="ts">
// ⚠ Заголовок — тот же, что в реестре архива (`app/config/legalArchive.ts`): один документ не может
// называться по-разному в зависимости от того, с какого адреса на него смотрят.
// Политика конфиденциальности (#297). Источник — `docs/privacy-policy.md`; см. комментарий в
// `eula.vue` о том, почему страница рендерит файл, а не повторяет его.
import source from '~~/docs/privacy-policy.md?raw'
</script>

<template>
  <LegalDocument
    :source="source"
    title="Политика конфиденциальности приложения"
    path="/privacy"
    archive-slug="privacy"
    description="Какие данные обрабатывает приложение «AI-импорт прайсов в Bitrix24», куда они передаются и сколько хранятся."
  />
</template>
