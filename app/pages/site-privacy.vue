<script setup lang="ts">
// Политика конфиденциальности САЙТА (#297, пакет юриста 2026-08-08). Описывает обработку данных
// ПОСЕТИТЕЛЯ сайта (демо-разбор, форма заявки, аналитика) — это другая аудитория и другой состав
// данных, чем у политики приложения. Источник — `docs/site-privacy.md`.
import source from '~~/docs/site-privacy.md?raw'
</script>

<template>
  <LegalDocument
    :source="source"
    title="Политика конфиденциальности сайта"
    path="/site-privacy"
    description="Какие данные посетителя обрабатывает сайт price-import.bx-shef.by и на каких условиях."
  />
</template>
