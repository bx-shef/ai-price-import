<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useSettings } from '~/composables/useSettings'
import { useCatalogProperties } from '~/composables/useCatalogProperties'

// In-portal settings: per-portal mapping (P3 UI). Core fields — target entity, file
// saving, supplier-article field, product strategy. Layout `clear`, prerendered.
// UI on native b24ui controls (B24Button/B24Input/B24Select/B24Switch/B24RadioGroup).
definePageMeta({ layout: 'clear' })
useHead({ title: 'Настройки импорта' })

const { mapping, loading, saving, saved, error, load, save } = useSettings()
onMounted(load)

// Supplier-article field: searchable picker over the portal's catalog product
// properties (P7). The model carries the property CODE (string); coerce the picker's
// `string | undefined` to the mapping's non-optional field.
const { fetcher: articleFetcher } = useCatalogProperties()
const articleField = computed<string | undefined>({
  get: () => mapping.value.article.field || undefined,
  set: (v) => { mapping.value.article.field = v ?? '' }
})
// Seed the picker's selected option so a SAVED code shows (as label) before the
// property list is fetched (lazy, on first open) — otherwise the field looks blank.
// On a real pick, capture the property's human label so it shows going forward.
const selectedArticle = ref<Record<string, unknown> | undefined>()
watch(() => mapping.value.article.field, (code) => {
  if (!code) {
    selectedArticle.value = undefined
    return
  }
  if (selectedArticle.value?.value !== code) selectedArticle.value = { value: code, label: code }
}, { immediate: true })
function onArticlePicked(o: Record<string, unknown> | undefined) {
  selectedArticle.value = o
}

// Quote (КП, id 7) is intentionally absent — it has no filterable external-marker field, so
// retry-idempotency by B24-search is impossible; support deferred (issue #135).
const TARGET_PRESETS = [
  { id: 2, label: 'Сделка' },
  { id: 31, label: 'Смарт-счёт' }
]

const ARTICLE_KIND_ITEMS = [
  { label: 'построчно (текст)', value: 'text' },
  { label: 'через разделитель', value: 'string' }
]

const ON_MISSING_ITEMS = [
  { label: 'Пропустить строку (предупреждение)', value: 'skip-warn' },
  { label: 'Создать товар в каталоге', value: 'create' },
  { label: 'Внести как произвольную позицию', value: 'freeform' }
]
</script>

<template>
  <div class="mx-auto max-w-2xl p-4 sm:p-6">
    <h1 class="mb-1 text-xl font-semibold">
      Настройки импорта
    </h1>
    <p class="mb-5 text-sm text-gray-500">
      Куда и как приложение вносит товары из документов в вашем портале.
    </p>

    <B24Alert
      v-if="error"
      class="mb-4"
      color="air-primary-warning"
      :title="error"
    />

    <div
      class="space-y-6"
      :class="{ 'pointer-events-none opacity-50': loading }"
    >
      <!-- Целевая сущность -->
      <B24FormField label="Целевая сущность CRM">
        <div class="flex flex-wrap gap-2">
          <B24Button
            v-for="p in TARGET_PRESETS"
            :key="p.id"
            :label="p.label"
            size="sm"
            :color="mapping.defaultTarget.entityTypeId === p.id ? 'air-primary' : 'air-tertiary-no-accent'"
            :aria-pressed="mapping.defaultTarget.entityTypeId === p.id"
            @click="() => { mapping.defaultTarget.entityTypeId = p.id }"
          />
        </div>
        <div class="mt-2 flex items-center gap-2">
          <span class="text-xs text-gray-500">или ID типа (смарт-процесс ≥ 1000):</span>
          <B24InputNumber
            v-model="mapping.defaultTarget.entityTypeId"
            :min="1"
            class="w-28"
            aria-label="ID типа целевой сущности"
          />
        </div>
      </B24FormField>

      <!-- Поле артикула поставщика -->
      <B24FormField label="Поле артикула поставщика">
        <AsyncSearchSelect
          v-model="articleField"
          :fetcher="articleFetcher"
          :selected-option="selectedArticle"
          :min-chars="0"
          placeholder="Выберите свойство каталога…"
          @update:selected-option="onArticlePicked"
        />
        <B24RadioGroup
          v-model="mapping.article.kind"
          :items="ARTICLE_KIND_ITEMS"
          orientation="horizontal"
          class="mt-2"
        />
        <B24Input
          v-if="mapping.article.kind === 'string'"
          v-model="mapping.article.delimiter"
          placeholder="разделитель, например ;"
          class="mt-2 w-32"
        />
      </B24FormField>

      <!-- Стратегия товара -->
      <B24FormField label="Если товар не найден">
        <B24Select
          v-model="mapping.product.onMissing"
          :items="ON_MISSING_ITEMS"
          class="w-full"
        />
      </B24FormField>

      <!-- Сохранение файла -->
      <B24Switch
        v-model="mapping.saveFile"
        label="Сохранять исходный файл"
        description="На общий Диск портала, в папку приложения по месяцам."
      />
    </div>

    <div class="mt-8 flex items-center gap-3">
      <B24Button
        color="air-primary"
        :loading="saving"
        :disabled="saving || loading"
        :label="saving ? 'Сохранение…' : 'Сохранить'"
        @click="save"
      />
      <span
        v-if="saved"
        class="text-sm text-green-600"
      >Сохранено ✓</span>
    </div>
  </div>
</template>
