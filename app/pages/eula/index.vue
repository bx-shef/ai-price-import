<script setup lang="ts">
// Лицензионное соглашение (#297). Источник — `docs/eula.md`, страница его РЕНДЕРИТ: второй копии
// текста нет, поэтому она не может устареть. Требование Маркета Bitrix24 — постоянный публичный
// HTTPS-адрес, поэтому страница пререндерится и НЕ закрыта от индексации.
import source from '~~/docs/eula.md?raw'
</script>

<template>
  <LegalDocument
    :source="source"
    title="Лицензионное соглашение"
    path="/eula"
    archive-slug="eula"
    description="Условия использования приложения «AI-импорт прайсов в Bitrix24»: предмет, права, ограничения и гарантии."
  />
</template>
