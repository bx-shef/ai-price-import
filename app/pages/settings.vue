<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { useSettings } from '~/composables/useSettings'
import { useCatalogProperties } from '~/composables/useCatalogProperties'
import { useChatSearch } from '~/composables/useChatSearch'
import { useCatalogMeasures } from '~/composables/useCatalogMeasures'
import { useCrmCategories } from '~/composables/useCrmCategories'
import { useCrmStages } from '~/composables/useCrmStages'
import * as catPicker from '~/utils/categoryPicker'
import * as stagePicker from '~/utils/stagePicker'
import type { CrmStageOption } from '~/utils/stagePicker'
import type { CrmCategoryOption } from '~/utils/categoryPicker'
import { dictionaryToRows, rowsToDictionary, hasDuplicateUnits } from '~/utils/unitsDictionary'
import { rulesToRows, rowsToRules, DOCUMENT_TYPES } from '~/utils/routingRulesEditor'

// In-portal settings: per-portal mapping (P3 UI). Core fields — target entity, file
// saving, supplier-article field, product strategy. Layout `clear`, prerendered.
// UI on native b24ui controls (B24Button/B24Input/B24Select/B24Switch/B24RadioGroup).
definePageMeta({ layout: 'clear' })
useHead({ title: 'Настройки импорта' })

const { mapping, loading, saving, saved, error, isAdmin, load, save, scheduleSave, flushSave, rebaseline } = useSettings()
// Show the "read-only for non-admins" notice once settings have loaded (in a portal) and the
// caller isn't an admin. Writes are also blocked server-side + in useSettings.
const showReadOnly = computed(() => !loading.value && !error.value && !isAdmin.value)
onMounted(async () => {
  await load()
  seedUnitRows() // build editable unit rows from the freshly-loaded dictionary (once)
  seedRoutingRows() // build editable routing rules from the loaded mapping (once)
  await loadMeasures() // populate the measure dropdowns
  // The category/stage `immediate` watchers reconcile the loaded mapping (dropping a categoryId/
  // stageId whose funnel/stage was deleted in the portal) AFTER their REST fetches resolve — later
  // than this onMounted. Await those same (cached) fetches + flush watchers so that open-time
  // normalization is already applied, THEN re-baseline the echo guard: opening the form (even with a
  // stale target) never autosaves — only genuine user edits do.
  await settleOpenReconciles()
  await nextTick()
  rebaseline()
  // Autosave: register the deep watch only now (post-seed, post-reconcile). Bound to this instance →
  // auto-disposed on unmount. useSettings gates each fire on `ready` + a content snapshot.
  watch(mapping, scheduleSave, { deep: true })
})
// Flush a pending autosave when leaving the page so the last edit isn't lost mid-debounce.
onBeforeUnmount(flushSave)

/** Await the open-time direction/stage reconcile fetches for the default target and every routing
 *  row (the same idempotent/cached `ensure*` the immediate watchers use), so their normalization of
 *  the loaded mapping settles before the autosave baseline is taken. */
async function settleOpenReconciles(): Promise<void> {
  const dt = mapping.value.defaultTarget
  const jobs: Array<Promise<void>> = [ensureCategories(dt.entityTypeId), ensureStages(dt.entityTypeId, dt.categoryId)]
  for (const r of routingRows.value) {
    if (r.entityTypeId) jobs.push(ensureCategories(r.entityTypeId), ensureStages(r.entityTypeId, r.categoryId))
  }
  await Promise.allSettled(jobs)
}

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

// Routing rules editor: send a document to a target by its classified type and/or keywords
// (first matching rule wins, else the default target below). Same rows↔stored pattern as units.
// categoryId/stageId are not edited by the UI but ride along so a category/stage-scoped target
// (only settable via app.option today) is not stripped on the round-trip.
interface EditableRoutingRow { id: number, type: string, keywords: string, entityTypeId: number | null, categoryId?: number, stageId?: string }
let nextRuleId = 1
const routingRows = ref<EditableRoutingRow[]>([])
function seedRoutingRows() {
  routingRows.value = rulesToRows(mapping.value.routingRules).map(r => ({ id: nextRuleId++, ...r }))
}
function addRoutingRow() {
  routingRows.value.push({ id: nextRuleId++, type: '', keywords: '', entityTypeId: null })
}
function removeRoutingRow(id: number) {
  routingRows.value = routingRows.value.filter(r => r.id !== id)
}
watch(routingRows, (rows) => {
  mapping.value.routingRules = rowsToRules(rows.map(r => ({ type: r.type, keywords: r.keywords, entityTypeId: r.entityTypeId, categoryId: r.categoryId, stageId: r.stageId })))
}, { deep: true })
// Type dropdown: the known document types + «любой тип» (empty → match by keywords only).
const DOCUMENT_TYPE_ITEMS = [{ label: 'любой тип', value: '' }, ...DOCUMENT_TYPES.map(t => ({ label: t, value: t }))]

// Quote (КП, id 7) is intentionally absent — it has no filterable external-marker field, so
// retry-idempotency by B24-search is impossible; support deferred (issue #135).
// Switching the entity type invalidates the direction (a deal funnel id doesn't belong to a
// smart-invoice, and a lead has none — crm.item.add would reject «Item has no CATEGORY_ID field»).
// Clear categoryId SYNCHRONOUSLY on any change so a stale id can't be saved in the sub-second
// window before the async category reload reconciles it (crm-sync also guards leads, #135).
function selectDefaultTarget(id: number): void {
  if (mapping.value.defaultTarget.entityTypeId !== id) mapping.value.defaultTarget.categoryId = undefined
  mapping.value.defaultTarget.entityTypeId = id
}
/** Rule-row entity change: coerce to a positive int (or null) and clear a now-stale direction. */
function setRowEntity(row: EditableRoutingRow, v: unknown): void {
  const n = typeof v === 'number' ? v : Number(v)
  const next = Number.isInteger(n) && n > 0 ? n : null
  if (next !== row.entityTypeId) row.categoryId = undefined
  row.entityTypeId = next
}

const TARGET_PRESETS = [
  { id: 1, label: 'Лид' },
  { id: 2, label: 'Сделка' },
  { id: 31, label: 'Смарт-счёт' }
]

// Direction (воронка/категория) pickers for routing targets: «тип документа → сущность +
// НАПРАВЛЕНИЕ» (owner ask). Categories are loaded per entity type from the portal
// (crm.category.list, frame token) and cached; lead (1) has none → the picker hides. Switching
// entity type clears a categoryId that isn't valid for the new type (a deal funnel id must not
// ride onto a smart-invoice / lead). Stage selection is a separate later slice. Outside a portal
// frame there's no data → the picker stays hidden (like the article picker).
const { load: loadCrmCategories } = useCrmCategories()
const catCache = ref<Record<number, CrmCategoryOption[]>>({})

async function ensureCategories(entityTypeId: number | null | undefined): Promise<void> {
  const etid = Number(entityTypeId)
  if (!Number.isInteger(etid) || etid <= 0 || etid in catCache.value) return
  catCache.value[etid] = await loadCrmCategories(etid)
}

// Thin wrappers over the pure app/utils/categoryPicker helpers (unit-tested there): look the
// entity's cached funnels up, delegate the transform. `catCache.value[etid]` is `undefined` until
// loaded (→ reconcile leaves the id) and `[]` once loaded-empty (→ reconcile clears a stale id).
const catsFor = (entityTypeId: number | null | undefined): CrmCategoryOption[] | undefined => catCache.value[Number(entityTypeId)]
const categoryItems = (entityTypeId: number | null | undefined) => catPicker.categoryItems(catsFor(entityTypeId))
const hasCategories = (entityTypeId: number | null | undefined) => catPicker.hasCategories(catsFor(entityTypeId))
const categoryValue = (target: catPicker.CategoryTarget) => catPicker.categoryValue(target)
const setCategory = (target: catPicker.CategoryTarget, v: unknown) => catPicker.setCategory(target, v)
const reconcileCategory = (target: catPicker.CategoryTarget) => catPicker.reconcileCategory(target, catsFor(target.entityTypeId))

// Default target: (re)load directions when its entity changes; reconcile a stale categoryId.
watch(() => mapping.value.defaultTarget.entityTypeId, async (etid) => {
  await ensureCategories(etid)
  reconcileCategory(mapping.value.defaultTarget)
}, { immediate: true })

// Routing rows: load directions for each row's entity (memoized) and reconcile after load.
// Runs on seed and on any row edit; ensureCategories short-circuits when already cached.
watch(routingRows, (rows) => {
  for (const r of rows) {
    if (r.entityTypeId) void ensureCategories(r.entityTypeId).then(() => reconcileCategory(r as { entityTypeId: number, categoryId?: number }))
  }
}, { deep: true, immediate: true })

// Stage (стадия) picker — cascades from entity + direction («тип → сущность → направление → СТАДИЯ»).
// crm.status.list ENTITY_ID depends on both, so the cache is keyed by `entityTypeId:categoryId`.
// Loaded from the portal (frame token) + reconciled when the direction/entity changes; the deal
// default funnel and leads have stages without a direction. Outside a portal → hidden. Optional
// (empty = the entity's default/first stage).
const { load: loadCrmStages } = useCrmStages()
const stageCache = ref<Record<string, CrmStageOption[]>>({})
const stageKey = (etid: number | null | undefined, cat: number | null | undefined): string => `${Number(etid)}:${cat ?? ''}`
async function ensureStages(etid: number | null | undefined, cat: number | null | undefined): Promise<void> {
  const n = Number(etid)
  if (!Number.isInteger(n) || n <= 0) return
  const key = stageKey(etid, cat)
  if (key in stageCache.value) return
  stageCache.value[key] = await loadCrmStages(n, cat ?? null)
}
const stagesFor = (t: { entityTypeId?: number | null, categoryId?: number }): CrmStageOption[] | undefined => stageCache.value[stageKey(t.entityTypeId, t.categoryId)]
const stageItemsFor = (t: { entityTypeId?: number | null, categoryId?: number }) => stagePicker.stageItems(stagesFor(t))
const hasStagesFor = (t: { entityTypeId?: number | null, categoryId?: number }) => stagePicker.hasStages(stagesFor(t))
const stageValueOf = (t: stagePicker.StageTarget) => stagePicker.stageValue(t)
const setStageOf = (t: stagePicker.StageTarget, v: unknown) => stagePicker.setStage(t, v)
const reconcileStageOf = (t: { entityTypeId?: number | null, categoryId?: number, stageId?: string }) => stagePicker.reconcileStage(t, stagesFor(t))

watch(() => [mapping.value.defaultTarget.entityTypeId, mapping.value.defaultTarget.categoryId], async () => {
  await ensureStages(mapping.value.defaultTarget.entityTypeId, mapping.value.defaultTarget.categoryId)
  reconcileStageOf(mapping.value.defaultTarget)
}, { immediate: true })

watch(routingRows, (rows) => {
  for (const r of rows) {
    if (r.entityTypeId) void ensureStages(r.entityTypeId, r.categoryId).then(() => reconcileStageOf(r))
  }
}, { deep: true, immediate: true })

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

    <B24Alert
      v-if="showReadOnly"
      class="mb-4"
      color="air-primary-warning"
      variant="soft"
      title="Настройки доступны только администратору"
      description="Изменять параметры импорта может только администратор портала Bitrix24."
    />

    <div
      v-if="!showReadOnly"
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
            @click="() => selectDefaultTarget(p.id)"
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
        <div
          v-if="hasCategories(mapping.defaultTarget.entityTypeId)"
          class="mt-2 flex items-center gap-2"
        >
          <span class="text-xs text-gray-500">направление (воронка):</span>
          <B24Select
            :model-value="categoryValue(mapping.defaultTarget)"
            :items="categoryItems(mapping.defaultTarget.entityTypeId)"
            class="w-56"
            aria-label="Направление целевой сущности по умолчанию"
            @update:model-value="(v: unknown) => setCategory(mapping.defaultTarget, v)"
          />
        </div>
        <div
          v-if="hasStagesFor(mapping.defaultTarget)"
          class="mt-2 flex items-center gap-2"
        >
          <span class="text-xs text-gray-500">стадия:</span>
          <B24Select
            :model-value="stageValueOf(mapping.defaultTarget)"
            :items="stageItemsFor(mapping.defaultTarget)"
            class="w-56"
            aria-label="Стадия целевой сущности по умолчанию"
            @update:model-value="(v: unknown) => setStageOf(mapping.defaultTarget, v)"
          />
        </div>
      </B24FormField>

      <!-- Правила маршрутизации -->
      <B24FormField label="Правила маршрутизации (по типу/словам → цель)">
        <p class="mb-2 text-xs text-gray-500">
          Первое совпавшее правило задаёт цель; иначе — целевая сущность выше. Тип цели: 1 = лид, 2 = сделка, 31 = смарт-счёт, ≥ 1000 = смарт-процесс.
        </p>
        <div class="space-y-2">
          <div
            v-for="(row, i) in routingRows"
            :key="row.id"
            class="flex flex-wrap items-center gap-2"
          >
            <B24Select
              v-model="row.type"
              :items="DOCUMENT_TYPE_ITEMS"
              class="w-40"
              :aria-label="`Правило ${i + 1}: тип документа`"
            />
            <B24Input
              v-model="row.keywords"
              placeholder="слова через запятую (необязательно)"
              class="w-56"
              :aria-label="`Правило ${i + 1}: ключевые слова`"
            />
            <span
              class="text-gray-400"
              aria-hidden="true"
            >→</span>
            <B24InputNumber
              :model-value="row.entityTypeId"
              :min="1"
              class="w-28"
              :aria-label="`Правило ${i + 1}: тип целевой сущности`"
              @update:model-value="(v: unknown) => setRowEntity(row, v)"
            />
            <B24Select
              v-if="hasCategories(row.entityTypeId)"
              :model-value="categoryValue(row)"
              :items="categoryItems(row.entityTypeId)"
              class="w-48"
              :aria-label="`Правило ${i + 1}: направление`"
              @update:model-value="(v: unknown) => setCategory(row, v)"
            />
            <B24Select
              v-if="hasStagesFor(row)"
              :model-value="stageValueOf(row)"
              :items="stageItemsFor(row)"
              class="w-44"
              :aria-label="`Правило ${i + 1}: стадия`"
              @update:model-value="(v: unknown) => setStageOf(row, v)"
            />
            <B24Button
              color="air-tertiary-no-accent"
              size="sm"
              label="✕"
              :aria-label="`Удалить правило ${i + 1}`"
              @click="() => removeRoutingRow(row.id)"
            />
          </div>
        </div>
        <B24Button
          class="mt-2"
          color="air-tertiary"
          size="sm"
          label="+ Добавить правило"
          @click="addRoutingRow"
        />
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
            v-for="(row, i) in unitRows"
            :key="row.id"
            class="flex items-center gap-2"
          >
            <B24Input
              v-model="row.unit"
              placeholder="из документа, напр. м"
              class="w-40"
              :aria-label="`Единица ${i + 1}: из документа`"
            />
            <span
              class="text-gray-400"
              aria-hidden="true"
            >→</span>
            <B24Select
              :model-value="row.code != null ? String(row.code) : undefined"
              :items="measureItems"
              placeholder="Ед. Б24"
              class="w-56"
              :aria-label="`Единица ${i + 1}: соответствие Б24`"
              @update:model-value="(v) => { row.code = v ? Number(v) : null }"
            />
            <B24Button
              color="air-tertiary-no-accent"
              size="sm"
              label="✕"
              :aria-label="`Удалить единицу ${i + 1}`"
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

    <div
      v-if="!showReadOnly"
      class="mt-8 flex items-center gap-3"
    >
      <B24Button
        color="air-primary"
        :loading="saving"
        :disabled="saving || loading || !isAdmin"
        :label="saving ? 'Сохранение…' : 'Сохранить сейчас'"
        @click="save"
      />
      <span
        class="text-sm"
        :class="saving ? 'text-gray-500' : 'text-green-600'"
        role="status"
        aria-live="polite"
      >
        <template v-if="saving">Сохранение…</template>
        <template v-else-if="saved">Сохранено ✓</template>
        <template v-else>Изменения сохраняются автоматически</template>
      </span>
    </div>
  </div>
</template>
