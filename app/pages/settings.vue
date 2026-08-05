<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, type Ref } from 'vue'
import { navigateTo } from '#app'
import CrossMIcon from '@bitrix24/b24icons-vue/outline/CrossMIcon'
import { useSettings } from '~/composables/useSettings'
import { useSettingsSync } from '~/composables/useSettingsSync'
import { useB24 } from '~/composables/useB24'
import { useCatalogProperties } from '~/composables/useCatalogProperties'
import { useChatSearch } from '~/composables/useChatSearch'
import { useCatalogMeasures } from '~/composables/useCatalogMeasures'
import { dictionaryToRows, rowsToDictionary, hasDuplicateUnits } from '~/utils/unitsDictionary'
import { BUILTIN_UNIT_HINT } from '~/utils/units'
import { rulesToRows, rowsToRules } from '~/utils/routingRulesEditor'
import { MAX_SAVINGS_RATE, isPortalConfigured, parsePortalSettings } from '~/utils/portalSettings'
import type { TargetRef } from '~/types/mapping'
import { APP_SLIDER_PLACE_SETTINGS } from '~/config/b24'
import { ON_MISSING_FIELD_LABEL, ON_MISSING_ITEMS } from '~/config/onMissing'
import { portalCurrencySettingsUrl } from '~/utils/entityLink'

// In-portal settings: per-portal mapping (P3 UI). Core fields — target entity, file
// saving, supplier-article field, product strategy. Layout `clear`, prerendered.
// UI on native b24ui controls (B24Button/B24Input/B24Select/B24Switch/B24RadioGroup).
definePageMeta({ layout: 'clear' })
useHead({ title: 'Настройки импорта', meta: [{ name: 'robots', content: 'noindex' }] }) // in-portal shell, see /app

const { mapping, loading, saving, saved, error, loadError, isAdmin, baseCurrency, currencyUnknown, loaded, load, save } = useSettings()
const { notifyReload } = useSettingsSync()
const { init: initB24, get: getFrame, auth: frameAuth, placementPlace, closeSlider } = useB24()
// How settings was reached, so Save/Cancel do the right «close»:
//  • isSlider — opened as a B24 slider (openSliderAppPage({place:'app-options'})) → close the slider
//    overlay (parent.closeApplication); the /app frame behind it live-reloads via the pull.
//  • inPortal (not slider) — reached by in-frame navigation (SDK slider unavailable) → return to /app.
//  • standalone (neither) — a plain page/direct link → stay put (Save shows ✓, Cancel reloads).
// ⚠ `null` — ещё не знаем (#408): со стартовым `false` экран на первом рендере считал себя «вне
// портала» и успевал показать значения по умолчанию до завершения рукопожатия.
const inPortal = ref<boolean | null>(null)
const isSlider = ref(false)
// Show the "read-only for non-admins" notice once settings have loaded (in a portal) and the
// caller isn't an admin. Writes are also blocked server-side + in useSettings.
const showReadOnly = computed(() => !loading.value && !error.value && !isAdmin.value)

onMounted(async () => {
  // Detect the portal frame + slider mode (inert/no-op standalone) so Save/Cancel close correctly.
  try {
    await initB24()
    inPortal.value = !!getFrame()
    isSlider.value = placementPlace() === APP_SLIDER_PLACE_SETTINGS
    // Portal domain for the «завести валюту» link. Standalone → stays empty → no link rendered.
    portalDomain.value = frameAuth()?.domain ?? ''
  } catch { /* standalone → stay put on Save/Cancel */ }
  await load()
  seedUnitRows() // build editable unit rows from the freshly-loaded dictionary (once)
  seedRoutingRows() // build editable routing rules from the loaded mapping (once)
  await loadMeasures() // populate the measure dropdowns
  await nextTick()
})

/** Explicit save (starter Save/Cancel pattern — no autosave). On success, notify other open
 *  instances to reload (pull `reload.options`), then close per how settings was opened. */
async function saveAndClose(): Promise<void> {
  await save()
  if (error.value) return // save() sets error; keep the form open so the admin can retry
  void notifyReload()
  await closeAfter()
}
/** Cancel: close per how settings was opened (slider → close overlay, in-frame → back to /app); as a
 *  plain page reload the server copy. Re-seed the unit/routing row editors from the reloaded mapping —
 *  they're seeded once on mount, so a bare load() would leave them showing the pre-cancel edits. */
async function cancel(): Promise<void> {
  if (isSlider.value || inPortal.value) {
    await closeAfter()
    return
  }
  await load()
  seedUnitRows()
  seedRoutingRows()
}
/** Close the settings view: as a slider → close the B24 overlay (parent.closeApplication); as an
 *  in-frame page → navigate back to /app (same-origin SPA route, the frame handshake survives so the
 *  token stays valid); standalone → no-op (caller handles Save-stays / Cancel-reload). */
async function closeAfter(): Promise<void> {
  if (isSlider.value) {
    await closeSlider()
    return
  }
  if (inPortal.value) await navigateTo('/app')
}

// Разделы страницы (#259, блоки-пары шаблона вместо аккордеона). Схлопывание заменено навигацией:
// в аккордеоне закрытая секция ПРЯТАЛА настройки, и «что вообще можно настроить» было видно только
// по заголовкам. Теперь все блоки развёрнуты и стоят друг под другом, а тулбар каркаса ведёт по
// якорям — как в референсном шаблоне, где подразделы настроек живут в `B24NavigationMenu` тулбара.
const SECTIONS = [
  { id: 'routing', label: 'Куда импортировать', description: 'Целевая сущность по умолчанию и правила: какие документы куда вносить.' },
  { id: 'products', label: 'Товары и единицы', description: 'По какому полю искать товар в каталоге, что делать с ненайденными и как читать единицы измерения.' },
  { id: 'notify', label: 'Файл и уведомления', description: 'Копия исходного файла на Диске и чаты, куда приходят сообщения об импорте.' },
  { id: 'savings', label: 'Экономия', description: 'Ставка часа для плитки «Сэкономлено денег» на главном экране.' }
] as const
const sectionNav = computed(() => SECTIONS.map(x => ({ label: x.label, to: `#${x.id}` })))

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
/**
 * Выбор свойства артикула.
 *
 * ⚠ Вместе с кодом сохраняется ИНФОБЛОК (`scope`): свойство живёт либо у торговых предложений,
 * либо у товаров, и подбор обязан искать ровно там. Портал молча игнорирует фильтр по свойству,
 * которого в инфоблоке нет, и возвращает весь список — то есть «поискать в обоих» означало бы в
 * одном из них получить весь каталог.
 */
function onArticlePicked(o: Record<string, unknown> | undefined) {
  selectedArticle.value = o
  const scope = o?.scope
  mapping.value.article.scope = scope === 'offer' ? 'offer' : 'product'
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

// Hourly rate for the «Сэкономлено денег» tile (#270). B24InputNumber, not a text field: it gives
// a numeric model plus min/max/step, so there is no string↔number layer to get wrong (a text field
// normalising on every keystroke ate the decimal separator mid-typing and made sub-1 rates
// unenterable). The CURRENCY is not chosen here — it is the portal's own base currency, resolved
// server-side. Empty/zero ⇒ the key is dropped and the dashboard shows time only.
const savingsRate = computed<number | undefined>({
  get: () => mapping.value.savings?.ratePerHour,
  // Coercion and the upper clamp stay in ONE place — the same parser the server re-applies on save.
  set: (v) => { mapping.value.savings = parsePortalSettings({ savings: { ratePerHour: v } }).savings }
})

// The rate is entered in the portal's BASE currency, and there is no field for it — so the code is
// shown next to the input. When the portal has none, the money tile can never appear no matter what
// is typed here (computeSavings drops the amount without a currency), so that case gets a red alert
// with a link to the portal's own currency settings instead of a silently missing tile.
const portalDomain = ref('')
const currencyLink = computed(() => portalCurrencySettingsUrl(portalDomain.value))

// #311. Two separate things, deliberately not merged:
//   • the FORMAT — the portal's own currency code inside the field, so «в чём я ввожу» is answered
//     where the answer is needed; the decimal and group separators come from the ru locale, which
//     is how the admin actually types («9,9»). No base currency ⇒ no format-options at all: an
//     Intl currency format needs a valid code, and a wrong guess would print someone else's money.
//     `locale="ru"` is pinned rather than left to the browser: the hint below the field prints
//     «9,9», and a field formatting the same number as «9.9» would make a correct entry look wrong;
//   • the SEED — the reference figure for that currency, written into the field while the portal is
//     still being set up (see `shouldPrefillRate`), with a caption saying so. An unknown currency
//     gets neither seed nor caption: a rate borrowed from a neighbouring economy is worse than
//     silence.
const rateFormatOptions = computed(() =>
  baseCurrency.value
    ? {
        style: 'currency' as const,
        currency: baseCurrency.value,
        currencyDisplay: 'code' as const,
        // Currency style forces 2 decimals, so the field printed «9,90 BYN» under a hint saying
        // «9,9» — the same divergence the pinned locale exists to prevent, just one digit further
        // in. Both sides now drop a trailing zero and stop at hundredths.
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      }
    : undefined
)
const rateHint = computed(() => hourlyRateHint(baseCurrency.value))

// Seed the rate field with the reference figure for the portal's currency (#311, owner's call: the
// caption names a number, so the field must carry it — a caption saying «9,9» over an empty box asks
// the admin to retype what the app already knows).
//
// The decision itself is a tested pure function (`shouldPrefillRate`) — an inline version of it was
// guarded only by «the source contains these lines», and moving the assignment above its own check
// would have silently overwritten hand-entered rates.
//
// SEED, not a stored default: it is written into the form, never into the portal, until the admin
// presses «Сохранить» — so the number they see is the number that gets kept.
const rateSeeded = ref(false)
watch([loaded, baseCurrency], () => {
  const seed = shouldPrefillRate({
    loaded: loaded.value,
    isAdmin: isAdmin.value,
    configured: isPortalConfigured(mapping.value),
    current: mapping.value.savings?.ratePerHour,
    hint: rateHint.value?.rate ?? null
  })
  if (!seed) return
  savingsRate.value = rateHint.value!.rate
  rateSeeded.value = true
}, { immediate: true })

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

// «Что уже работает» — из самой встроенной карты, чтобы подсказка не разъехалась с поведением.
const builtinUnitHint = BUILTIN_UNIT_HINT.join(', ')

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

// Routing rules editor: send a document to a target BY KEYWORDS (owner ask — «Тип» removed; first
// matching rule wins, else the default target below). Both the default target and each rule's target
// are picked with the SAME shared <TargetPicker> as the import screen (owner: код общий) — so entity/
// direction/stage selection (incl. named smart processes, smart-invoice = stage-only, no-leads hiding)
// behaves identically everywhere. The row keeps the client-only `id` for a stable v-for key.
interface EditableRoutingRow { id: number, keywords: string, entityTypeId: number | null, categoryId?: number, stageId?: string, type?: string }
let nextRuleId = 1
const routingRows = ref<EditableRoutingRow[]>([])
function seedRoutingRows() {
  routingRows.value = rulesToRows(mapping.value.routingRules).map(r => ({ id: nextRuleId++, ...r }))
}
function addRoutingRow() {
  routingRows.value.push({ id: nextRuleId++, keywords: '', entityTypeId: null })
}
function removeRoutingRow(id: number) {
  routingRows.value = routingRows.value.filter(r => r.id !== id)
}
watch(routingRows, (rows) => {
  mapping.value.routingRules = rowsToRules(rows.map(r => ({ keywords: r.keywords, entityTypeId: r.entityTypeId, categoryId: r.categoryId, stageId: r.stageId, type: r.type })))
}, { deep: true })

// The default target ⇄ a TargetPicker model. The default target is always concrete (never «Авто»), so
// the picker is used with :include-auto="false"; a null emit (shouldn't happen without the Авто option)
// falls back to a deal so the default stays valid.
const defaultTargetModel = computed<TargetRef | null>({
  get: () => mapping.value.defaultTarget,
  set: (t) => { mapping.value.defaultTarget = t ?? { entityTypeId: 2 } }
})
// Per-rule target ⇄ TargetPicker: build a TargetRef from the row's fields and write the picked one back.
function rowTarget(row: EditableRoutingRow): TargetRef | null {
  return row.entityTypeId
    ? { entityTypeId: row.entityTypeId, ...(row.categoryId != null ? { categoryId: row.categoryId } : {}), ...(row.stageId ? { stageId: row.stageId } : {}) }
    : null
}
function setRowTarget(row: EditableRoutingRow, t: TargetRef | null): void {
  row.entityTypeId = t?.entityTypeId ?? null
  row.categoryId = t?.categoryId
  row.stageId = t?.stageId
}

const ARTICLE_KIND_ITEMS = [
  { label: 'построчно (текст)', value: 'text' },
  { label: 'через разделитель', value: 'string' }
]
</script>

<template>
  <!-- CLIENT-ONLY: depends on the B24 frame handshake; prerender+hydrate framed mismatched (see /app). -->
  <ClientOnly>
    <!-- Панель каркаса (#259): навбар и тулбар — в #header, контент — в #body. `:b24ui` МЕРДЖИТСЯ
         (tailwind-merge), не заменяет базу — `min-h-svh`/прокрутка/паддинг тела сняты явными
         конфликтующими классами `min-h-0`/`overflow-y-visible`/`gap-0`/`sm:p-0` (см. /app). -->
    <B24DashboardPanel
      id="settings"
      :b24ui="{ root: 'relative flex flex-col w-full min-w-0 min-h-0', body: 'flex flex-col gap-0 overflow-y-visible sm:p-0' }"
    >
      <template #header>
        <!-- Same chrome as /metrics: навбар каркаса (#259) с кнопкой закрытия. Механика закрытия не
             тронута — по-прежнему `cancel`, чтобы in-frame фолбэк возвращал на /app. -->
        <B24DashboardNavbar
          :toggle="false"
          title="Настройки импорта"
        >
          <template #leading>
            <B24Button
              :icon="CrossMIcon"
              color="air-tertiary-no-accent"
              size="xs"
              :aria-label="isSlider ? 'Закрыть' : 'Вернуться к обзору'"
              @click="cancel"
            />
          </template>
        </B24DashboardNavbar>

        <!-- Тулбар каркаса: навигация по разделам вместо схлопывания (#259). Аккордеон прятал
             настройки — «что вообще можно настроить» было видно только по заголовкам секций. -->
        <B24DashboardToolbar v-if="!showReadOnly">
          <!-- Без `highlight`: vue-router не учитывает hash при сравнении активного маршрута,
               поэтому подсветка горела бы на всех четырёх пунктах разом. -->
          <B24NavigationMenu
            :items="sectionNav"
            orientation="horizontal"
          />
        </B24DashboardToolbar>
      </template>

      <template #body>
        <div class="mx-auto w-full max-w-2xl p-4 pb-6 sm:p-6 lg:max-w-[672px]">
          <p class="mb-4 text-sm text-(--ui-color-base-3)">
            Здесь вы задаёте, куда приложение вносит товары из документов и как ищет их в вашем каталоге.
          </p>
          <!-- ⚠ Только НЕ-загрузочные ошибки (сохранение): при отказе загрузки о нём говорит
               `ScreenState` ниже, и без этого условия человек видел два алерта об одном отказе. -->
          <B24Alert
            v-if="error && !loadError"
            class="mb-4"
            color="air-primary-warning"
            :title="error"
          />

          <B24Alert
            v-if="showReadOnly"
            class="mb-4"
            color="air-primary-warning"
            title="Настройки доступны только администратору"
            description="Менять эти настройки может только администратор портала Bitrix24. Попросите его открыть эту страницу."
          />

          <!-- ⚠ Форма — под состоянием загрузки (#408). Прежде она рисовалась ДО прихода серверной
               копии, то есть со значениями по умолчанию: администратор видел настройки, которых не
               выбирал, и они на глазах подменялись сохранёнными. На медленной сети это читается как
               сброс настроек — худшая из возможных трактовок для экрана, где лежит конфигурация
               записи в CRM. Прежнее полумерное `opacity-50` от этого не спасало: приглушённые
               значения всё равно НАПИСАНЫ, а человек читает то, что видит, а не то, что кликабельно.
               `inert` — вне портала: там фрейм-токена нет, загрузка не начнётся никогда. -->
          <ScreenState
            :loaded="loaded"
            :error="loadError"
            :inert="inPortal === false"
            :on-retry="() => { void load() }"
          >
            <template #skeleton>
              <SettingsLoader />
            </template>
            <!-- Блоки-пары шаблона (#259, §1.3 issue): тонированная шапка + тело, вместе читаются как
             одна карточка. Скругления «rounded-none / sm:rounded-*-3xl» — как в референсе: на
             мобильном блок на всю ширину, на десктопе пара склеена. -->
            <div
              v-if="!showReadOnly"
              class="flex flex-col gap-4 sm:gap-6"
            >
              <section
                :id="SECTIONS[0].id"
                class="scroll-mt-16"
              >
                <B24PageCard
                  variant="tinted"
                  :title="SECTIONS[0].label"
                  :description="SECTIONS[0].description"
                  :b24ui="{ root: 'rounded-none sm:rounded-t-3xl' }"
                />
                <B24PageCard
                  variant="outline"
                  :b24ui="{ root: 'rounded-none border-t-0 sm:rounded-b-3xl' }"
                >
                  <div class="space-y-6">
                    <!-- Целевая сущность по умолчанию — тот же TargetPicker, что и на импорте (без «Авто»). -->
                    <B24FormField label="Куда вносить документы по умолчанию">
                      <TargetPicker
                        v-model:target="defaultTargetModel"
                        :include-auto="false"
                      />
                    </B24FormField>

                    <!-- Правила маршрутизации: по СЛОВАМ → цель (тот же TargetPicker). Первое совпавшее выигрывает. -->
                    <B24FormField label="Правила: какие документы куда вносить">
                      <p class="mb-2 text-xs text-(--ui-color-base-3)">
                        Приложение читает документ и ищет в нём эти слова. Сработает первое подходящее правило — документ уйдёт в его цель. Если ни одно не подошло, документ уйдёт в цель по умолчанию, указанную выше.
                      </p>
                      <div class="space-y-3">
                        <div
                          v-for="(row, i) in routingRows"
                          :key="row.id"
                          class="flex flex-wrap items-center gap-2 rounded-lg border border-(--ui-color-base-5) p-2"
                        >
                          <B24Input
                            v-model="row.keywords"
                            placeholder="например: накладная, ттн"
                            class="w-56"
                            :aria-label="`Правило ${i + 1}: ключевые слова`"
                          />
                          <span
                            class="text-(--ui-color-base-4)"
                            aria-hidden="true"
                          >→</span>
                          <TargetPicker
                            :target="rowTarget(row)"
                            :include-auto="false"
                            @update:target="(t: TargetRef | null) => setRowTarget(row, t)"
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
                  </div>
                </B24PageCard>
              </section>

              <section
                :id="SECTIONS[1].id"
                class="scroll-mt-16"
              >
                <B24PageCard
                  variant="tinted"
                  :title="SECTIONS[1].label"
                  :description="SECTIONS[1].description"
                  :b24ui="{ root: 'rounded-none sm:rounded-t-3xl' }"
                />
                <B24PageCard
                  variant="outline"
                  :b24ui="{ root: 'rounded-none border-t-0 sm:rounded-b-3xl' }"
                >
                  <div class="space-y-6">
                    <!-- Поле артикула поставщика -->
                    <B24FormField label="Свойство каталога с артикулом поставщика">
                      <!-- ⚠ Принцип подбора раньше не был описан НИГДЕ, и пустое поле выглядело
                           безобидным: человек не знал ни что артикул — единственный признак, ни что
                           внешний код работает без всякой настройки. -->
                      <p class="mb-2 text-xs text-(--ui-color-base-3)">
                        Товар в каталоге ищется <b>только по артикулу</b> из документа. По названию не
                        ищем: у каждого поставщика своё написание, и совпадение названий не значит, что
                        это тот же товар. Порядок: сначала <b>внешний код</b> торгового предложения,
                        затем внешний код товара — они работают всегда и настройки не требуют, — и
                        только потом свойство, выбранное здесь. Оставите поле пустым — останутся
                        внешние коды; если они у товаров не заполнены, каталог задействован не будет и
                        строки уйдут как есть, названиями из документа.
                      </p>
                      <AsyncSearchSelect
                        v-model="articleField"
                        :fetcher="articleFetcher"
                        :selected-option="selectedArticle"
                        :min-chars="0"
                        placeholder="Нажмите и выберите свойство каталога…"
                        group-key="group"
                        @update:selected-option="onArticlePicked"
                      />
                      <p class="mt-1 text-xs text-(--ui-color-base-3)">
                        В списке — свойства торговых предложений и товаров, разделённые заголовками.
                        Показаны только строковые и текстовые свойства: артикул хранится в них.
                      </p>
                      <p class="mt-2 mb-1 text-xs text-(--ui-color-base-3)">
                        Как в этом свойстве записаны артикулы, если их у товара несколько:
                      </p>
                      <B24RadioGroup
                        v-model="mapping.article.kind"
                        :items="ARTICLE_KIND_ITEMS"
                        orientation="horizontal"
                      />
                      <B24Input
                        v-if="mapping.article.kind === 'string'"
                        v-model="mapping.article.delimiter"
                        placeholder="разделитель, например ;"
                        class="mt-2 w-32"
                      />
                    </B24FormField>

                    <!-- Стратегия товара -->
                    <B24FormField :label="ON_MISSING_FIELD_LABEL">
                      <B24Select
                        v-model="mapping.product.onMissing"
                        :items="ON_MISSING_ITEMS"
                        class="w-full"
                      />
                      <!-- #373: у поля не было подсказки вовсе, а «пропустить» стояло первым в списке и
                     читалось как дефолт. На пустом каталоге оно пропускало ВЕСЬ документ. -->
                      <p class="mt-1 text-xs text-(--ui-color-base-3)">
                        По умолчанию строка вносится как есть. «Пропустить» подходит только при
                        заполненном каталоге: если не найдётся ни один товар, импорт остановится с
                        ошибкой и запись не создастся.
                      </p>
                    </B24FormField>

                    <!-- Единицы измерения -->
                    <B24FormField label="Единицы измерения">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="text-xs text-(--ui-color-base-3)">Какую единицу подставить, если в документе встретилась незнакомая:</span>
                        <B24Select
                          v-model="defaultMeasure"
                          :items="measureItems"
                          placeholder="единица в Б24"
                          class="w-56"
                          aria-label="Единица по умолчанию"
                        />
                      </div>

                      <!-- Пустая таблица раньше читалась как «ничего не работает, заполняйте руками»,
                     хотя встроенный словарь уже покрывает обычные единицы (#272). -->
                      <p class="mt-3 text-xs text-(--ui-color-base-3)">
                        Без настройки уже распознаются обычные единицы: {{ builtinUnitHint }} — вместе с
                        вариантами написания: «шт.», «ШТ», «штук», «м2» и «м²». Если такой единицы нет в
                        вашем Битрикс24, приложение её не подставит. Ниже добавляйте исключения: свои
                        единицы и те, что нужно сопоставить по-другому.
                      </p>

                      <p class="mt-3 mb-1 text-xs text-(--ui-color-base-3)">
                        Как называется единица в документе и какой единице Битрикс24 она соответствует:
                      </p>
                      <div class="space-y-2">
                        <div
                          v-for="(row, i) in unitRows"
                          :key="row.id"
                          class="flex items-center gap-2"
                        >
                          <B24Input
                            v-model="row.unit"
                            placeholder="как в документе, напр. м"
                            class="w-40"
                            :aria-label="`Единица ${i + 1}: из документа`"
                          />
                          <span
                            class="text-(--ui-color-base-4)"
                            aria-hidden="true"
                          >→</span>
                          <B24Select
                            :model-value="row.code != null ? String(row.code) : undefined"
                            :items="measureItems"
                            placeholder="единица в Б24"
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
                        title="Если одна и та же единица указана дважды, сработает последняя строка."
                      />
                    </B24FormField>
                  </div>
                </B24PageCard>
              </section>

              <section
                :id="SECTIONS[2].id"
                class="scroll-mt-16"
              >
                <B24PageCard
                  variant="tinted"
                  :title="SECTIONS[2].label"
                  :description="SECTIONS[2].description"
                  :b24ui="{ root: 'rounded-none sm:rounded-t-3xl' }"
                />
                <B24PageCard
                  variant="outline"
                  :b24ui="{ root: 'rounded-none border-t-0 sm:rounded-b-3xl' }"
                >
                  <div class="space-y-6">
                    <!-- Сохранение файла -->
                    <B24Switch
                      v-model="mapping.saveFile"
                      label="Сохранять исходный файл"
                      description="Копия каждого загруженного документа сохранится на Диск портала, в папку приложения с разбивкой по месяцам."
                    />

                    <!-- Чат уведомлений об успешном импорте -->
                    <B24FormField label="Чат уведомлений">
                      <AsyncSearchSelect
                        v-model="notifyChatId"
                        :fetcher="chatFetcher"
                        :selected-option="selectedNotifyChat"
                        :min-chars="3"
                        placeholder="Нажмите и выберите чат…"
                        @update:selected-option="(o: Record<string, unknown> | undefined) => { selectedNotifyChat = o }"
                      />
                      <p class="mt-1 text-xs text-(--ui-color-base-3)">
                        Сюда придёт сообщение, когда документ успешно внесён в CRM. Не выбирайте чат, если уведомления не нужны.
                      </p>
                    </B24FormField>

                    <!-- Чат ошибок -->
                    <B24FormField label="Чат ошибок">
                      <AsyncSearchSelect
                        v-model="errorChatId"
                        :fetcher="chatFetcher"
                        :selected-option="selectedErrorChat"
                        :min-chars="3"
                        placeholder="Нажмите и выберите чат…"
                        @update:selected-option="(o: Record<string, unknown> | undefined) => { selectedErrorChat = o }"
                      />
                      <p class="mt-1 text-xs text-(--ui-color-base-3)">
                        Сюда придёт сообщение, если документ внести не удалось — например, в портале нет нужной ставки НДС или валюты. Не выбирайте чат, если уведомления не нужны.
                      </p>
                    </B24FormField>
                  </div>
                </B24PageCard>
              </section>

              <section
                :id="SECTIONS[3].id"
                class="scroll-mt-16"
              >
                <B24PageCard
                  variant="tinted"
                  :title="SECTIONS[3].label"
                  :description="SECTIONS[3].description"
                  :b24ui="{ root: 'rounded-none sm:rounded-t-3xl' }"
                />
                <B24PageCard
                  variant="outline"
                  :b24ui="{ root: 'rounded-none border-t-0 sm:rounded-b-3xl' }"
                >
                  <div class="space-y-6">
                    <!-- Показываем ТОЛЬКО когда точно знаем, что валюты нет: в портале, после успешной
                   загрузки и когда чтение валюты не падало. Иначе страница утверждала бы «валюты
                   нет» на таймауте или до первой загрузки. -->
                    <B24Alert
                      v-if="inPortal && loaded && !error && !currencyUnknown && !baseCurrency"
                      color="air-primary-alert"
                      title="В портале нет базовой валюты"
                      description="Приложение не знает, в какой валюте считать сумму, поэтому плитка «Сэкономлено денег» не появится. Откройте настройки валют Битрикс24 и отметьте одну валюту базовой. Сэкономленное время показывается и без этого."
                    >
                      <!-- v-if на самом template: слот actions рендерит свою обёртку по факту наличия
                     слота, а не содержимого — иначе без ссылки остаётся пустой отступ. -->
                      <!-- Ссылку строим только для облачных адресов Битрикс24. У портала на своём домене
                     её не будет — тогда вместо тупика показываем сам путь словами. -->
                      <template #actions>
                        <a
                          v-if="currencyLink"
                          :href="currencyLink"
                          target="_blank"
                          rel="noopener noreferrer"
                          class="text-sm underline"
                        >
                          Открыть настройки валют
                        </a>
                        <span
                          v-else
                          class="text-sm"
                        >CRM → Настройки → Валюты</span>
                      </template>
                    </B24Alert>

                    <B24FormField label="Стоимость часа работы сотрудника">
                      <div class="flex items-center gap-2">
                        <B24InputNumber
                          v-model="savingsRate"
                          :min="0"
                          :max="MAX_SAVINGS_RATE"
                          :step="0.01"
                          :format-options="rateFormatOptions"
                          locale="ru"
                          class="w-56"
                        />
                        <span
                          v-if="baseCurrency"
                          class="text-sm text-(--ui-color-base-2)"
                        >в час</span>
                      </div>
                      <!-- Только когда значение ДЕЙСТВИТЕЛЬНО подставлено: текст говорит «Подставлен ориентир»,
                     и над пустым полем (не-админ, уже настроенный портал) он был бы неправдой. -->
                      <p
                        v-if="rateHint && rateSeeded"
                        class="mt-1 text-xs text-(--ui-color-base-2)"
                      >
                        {{ rateHint.text }}
                      </p>
                      <p class="mt-1 text-xs text-(--ui-color-base-3)">
                        Нужна только для плитки «Сэкономлено денег»: сэкономленное время × эта ставка.
                        Валюта — базовая валюта вашего портала, приложение берёт её из Битрикс24, вводить
                        не нужно. Оставьте пусто — плитки не будет, останется только время.
                      </p>
                    </B24FormField>
                  </div>
                </B24PageCard>
              </section>
            </div>

            <div
              v-if="!showReadOnly"
              class="mt-8 flex items-center gap-3"
            >
              <B24Button
                color="air-primary-success"
                :loading="saving"
                :disabled="saving || loading || !isAdmin"
                :label="saving ? 'Сохраняем…' : 'Сохранить'"
                @click="saveAndClose"
              />
              <B24Button
                color="air-tertiary"
                :disabled="saving"
                label="Отмена"
                @click="cancel"
              />
              <span
                v-if="saved && !saving"
                class="text-sm text-(--ui-color-accent-main-success)"
                role="status"
                aria-live="polite"
              >Настройки сохранены ✓</span>
            </div>
          </ScreenState>

          <BuildFooter />
        </div>
      </template>
    </B24DashboardPanel>
  </ClientOnly>
</template>
