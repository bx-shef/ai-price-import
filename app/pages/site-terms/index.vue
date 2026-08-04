<script setup lang="ts">
// Условия использования САЙТА (#297, пакет юриста 2026-08-08). Отдельная пара документов: сайт и
// приложение — разные продукты с разными аудиториями, поэтому у сайта свои условия и своя политика,
// а не раздел внутри лицензии. Источник — `docs/site-terms.md`, страница его РЕНДЕРИТ (второй копии
// текста нет — она не может устареть).
import source from '~~/docs/site-terms.md?raw'
</script>

<template>
  <LegalDocument
    :source="source"
    title="Условия использования сайта"
    path="/site-terms"
    archive-slug="site-terms"
    description="Правила использования сайта price-import.bx-shef.by и демонстрационного разбора документа."
  />
</template>
