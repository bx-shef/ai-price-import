<script setup lang="ts">
import { computed, onMounted, ref, watch, type Ref } from 'vue'
import { useSettings } from '~/composables/useSettings'
import { useCatalogProperties } from '~/composables/useCatalogProperties'
import { useChatSearch } from '~/composables/useChatSearch'
import { useCatalogMeasures } from '~/composables/useCatalogMeasures'
import { dictionaryToRows, rowsToDictionary, hasDuplicateUnits } from '~/utils/unitsDictionary'

// In-portal settings: per-portal mapping (P3 UI). Core fields — target entity, file
// saving, supplier-article field, product strategy. Layout `clear`, prerendered.
// UI on native b24ui controls (B24Button/B24Input/B24Select/B24Switch/B24RadioGroup).
definePageMeta({ layout: 'clear' })
useHead({ title: 'Настройки импорта' })

const { mapping, loading, saving, saved, error, load, save } = useSettings()
onMounted(async () => {
  await load()
  seedUnitRows() // build editable unit rows from the freshly-loaded dictionary (once)
  await loadMeasures() // populate the measure dropdowns
})

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

// Notify / error chat pickers (P3): search the portal's group chats via /api/chat-search.
// Both share one fetcher (same portal). The model stores the B24 DIALOG_ID `chat<id>`;
// clearing the picker (emits undefined) unsets the optional field so the worker skips it.
const { fetcher: chatFetcher } = useChatSearch()

// The model stores the B24 DIALOG_ID `chat<id>`; the optional field is unset (→ worker
// skips it) when the picker is cleared (emits '' / undefined).
const notifyChatId = computed<string | undefined>({
  get: () => mapping.value.notifyChatId || undefined,
  set: (v) => { mapping.value.notifyChatId = v || undefined }
})
const errorChatId = computed<string | undefined>({
  get: () => mapping.value.errorChatId || undefined,
  set: (v) => { mapping.value.errorChatId = v || undefined }
})

// Seed each picker's selected option so a SAVED id shows before the chat list is fetched
// (the mapping stores only the id, not the title → the raw `chat<id>` is the fallback label
// until the user re-picks). Mirrors the article-field seed.
const selectedNotifyChat = ref<Record<string, unknown> | undefined>()
const selectedErrorChat = ref<Record<string, unknown> | undefined>()
function seedChat(sel: Ref<Record<string, unknown> | undefined>, id: string | undefined) {
  if (!id) {
    sel.value = undefined
    return
  }
  if (sel.value?.value !== id) sel.value = { value: id, label: id }
}
watch(() => mapping.value.notifyChatId, id => seedChat(selectedNotifyChat, id), { immediate: true })
watch(() => mapping.value.errorChatId, id => seedChat(selectedErrorChat, id), { immediate: true })

// Units dictionary editor (Q11): map a document unit synonym ("м","кг") → a portal measure
// code, so quantities aren't all forced to the default (796/шт). Measures come from the portal
// (catalog.measure.list) as a small list — no search, just a dropdown per row.
const { measures, load: loadMeasures } = useCatalogMeasures()

// Editable rows carry a client-only `id` for a stable v-for key (avoids input focus j/loss on
// add/remove); the pure util deals in {unit,code}. Seeded ONCE from the loaded dictionary; from
// then on the editor is the source of truth and syncs rows → mapping.units.dictionary.
interface EditableUnitRow { id: number, unit: string, code: number | null }
let nextRowId = 1
const unitRows = ref<EditableUnitRow[]>([])
function seedUnitRows() {
  unitRows.value = dictionaryToRows(mapping.value.units.dictionary).map(r => ({ id: nextRowId++, ...r }))
}
function addUnitRow() {
  unitRows.value.push({ id: nextRowId++, unit: '', code: null })
}
function removeUnitRow(id: number) {
  unitRows.value = unitRows.value.filter(r => r.id !== id)
}
// rows → dictionary (one direction only, so no reseed loop). Deep watch catches unit/code edits.
watch(unitRows, (rows) => {
  mapping.value.units.dictionary = rowsToDictionary(rows.map(r => ({ unit: r.unit, code: r.code })))
}, { deep: true })
const duplicateUnits = computed(() => hasDuplicateUnits(unitRows.value.map(r => ({ unit: r.unit, code: r.code }))))

// Default measure (when no unit matches): mapping.units.defaultCode is a number; the Select
// carries strings. Empty/invalid selection keeps the current default (never write NaN).
const defaultMeasure = computed<string>({
  get: () => String(mapping.value.units.defaultCode || 796),
  set: (v) => {
    const n = Number(v)
    if (Number.isInteger(n) && n > 0) mapping.value.units.defaultCode = n
  }
})

// Measure options as b24ui Select items (value = code string). Merge a synthetic «код N» entry
// for the current default and any row code NOT in the portal list, so a saved code still shows a
// value BEFORE the list loads (async) or if the measure was later deactivated on the portal
// (catalog.measure.list filters active:Y). The real label wins once loaded (same code → skipped).
const measureItems = computed(() => {
  const items = measures.value.map(m => ({ label: m.label, value: m.value }))
  const present = new Set(items.map(i => i.value))
  const referenced = new Set<string>([String(mapping.value.units.defaultCode || 796)])
  for (const r of unitRows.value) if (r.code != null) referenced.add(String(r.code))
  for (const code of referenced) {
    if (code && !present.has(code)) items.push({ label: `код ${code}`, value: code })
  }
  return items
})

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

      <!-- Единицы измерения -->
      <B24FormField label="Единицы измерения">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs text-gray-500">По умолчанию (если единица не сопоставлена):</span>
          <B24Select
            v-model="defaultMeasure"
            :items="measureItems"
            placeholder="Ед. Б24"
            class="w-56"
            aria-label="Единица по умолчанию"
          />
        </div>

        <p class="mt-3 mb-1 text-xs text-gray-500">
          Сопоставление единиц из документа с единицами Б24:
        </p>
        <div class="space-y-2">
          <div
            v-for="row in unitRows"
            :key="row.id"
            class="flex items-center gap-2"
          >
            <B24Input
              v-model="row.unit"
              placeholder="из документа, напр. м"
              class="w-40"
              aria-label="Единица из документа"
            />
            <span class="text-gray-400">→</span>
            <B24Select
              :model-value="row.code != null ? String(row.code) : undefined"
              :items="measureItems"
              placeholder="Ед. Б24"
              class="w-56"
              aria-label="Единица Б24"
              @update:model-value="(v) => { row.code = v ? Number(v) : null }"
            />
            <B24Button
              color="air-tertiary-no-accent"
              size="sm"
              label="✕"
              aria-label="Удалить строку"
              @click="() => removeUnitRow(row.id)"
            />
          </div>
        </div>
        <B24Button
          class="mt-2"
          color="air-tertiary"
          size="sm"
          label="+ Добавить единицу"
          @click="addUnitRow"
        />
        <B24Alert
          v-if="duplicateUnits"
          class="mt-2"
          color="air-primary-warning"
          title="Повторяющиеся единицы — сработает последняя."
        />
      </B24FormField>

      <!-- Сохранение файла -->
      <B24Switch
        v-model="mapping.saveFile"
        label="Сохранять исходный файл"
        description="На общий Диск портала, в папку приложения по месяцам."
      />

      <!-- Чат уведомлений об успешном импорте -->
      <B24FormField label="Чат уведомлений">
        <AsyncSearchSelect
          v-model="notifyChatId"
          :fetcher="chatFetcher"
          :selected-option="selectedNotifyChat"
          :min-chars="3"
          placeholder="Выберите чат для уведомлений об импорте…"
          @update:selected-option="(o: Record<string, unknown> | undefined) => { selectedNotifyChat = o }"
        />
        <p class="mt-1 text-xs text-gray-500">
          Куда слать сообщение после успешной записи документа. Пусто — не уведомляем.
        </p>
      </B24FormField>

      <!-- Чат ошибок -->
      <B24FormField label="Чат ошибок">
        <AsyncSearchSelect
          v-model="errorChatId"
          :fetcher="chatFetcher"
          :selected-option="selectedErrorChat"
          :min-chars="3"
          placeholder="Выберите чат для сообщений об ошибках…"
          @update:selected-option="(o: Record<string, unknown> | undefined) => { selectedErrorChat = o }"
        />
        <p class="mt-1 text-xs text-gray-500">
          Куда слать сообщение, если документ не удалось внести (нет ставки НДС, валюты и т.п.). Пусто — не уведомляем.
        </p>
      </B24FormField>
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
