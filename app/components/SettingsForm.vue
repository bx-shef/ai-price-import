<script setup lang="ts">
import { computed, ref, watch, type Ref } from 'vue'
import { useCatalogProperties } from '~/composables/useCatalogProperties'
import { useChatSearch } from '~/composables/useChatSearch'
import { useCatalogMeasures } from '~/composables/useCatalogMeasures'
import { dictionaryToRows, rowsToDictionary, hasDuplicateUnits } from '~/utils/unitsDictionary'
import { BUILTIN_UNIT_HINT } from '~/utils/units'
import { rulesToRows, rowsToRules } from '~/utils/routingRulesEditor'
import { MAX_SAVINGS_RATE, isPortalConfigured, parsePortalSettings } from '~/utils/portalSettings'
import { targetInvalidMessage } from '~/utils/targetValidity'
import { portalCurrencySettingsUrl } from '~/utils/entityLink'
import { ON_MISSING_FIELD_LABEL, ON_MISSING_ITEMS } from '~/config/onMissing'
import { SETTINGS_SECTIONS as SECTIONS } from '~/config/settingsSections'
import type { PortalMapping, TargetRef } from '~/types/mapping'

// Форма настроек портала: четыре раздела и вся их обвязка (#523).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ КОМПОНЕНТ. `pages/settings.vue` была 863 строки, и в ней вперемешку жили две
// разные вещи: оболочка экрана (каркас портала, состояние загрузки, панель действий, механика
// закрытия слайдера) и модель формы (пикеры, строки словаря единиц, правила маршрутизации, посев
// ставки). Оболочку читают структурные гарды по тексту шаблона, а правят её и форму разные задачи —
// и правки конфликтовали между параллельными ветками на файле, который каждая трогала целиком.
//
// ⚠ Настройки приезжают в компонент ЧЕРЕЗ `v-model`, а не своим запросом: страница уже держит
// `useSettings()` ради состояния загрузки, признака админа и сохранения. Второй экземпляр
// композабла завёл бы ВТОРУЮ копию настроек (`useSettings` не singleton — каждый вызов создаёт свои
// ref'ы), и форма правила бы не тот объект, который уходит на сервер.
//
// ⚠ `B24Form` тут НЕ применён намеренно: он про валидацию по схеме (`schema` + `state`), а вся
// приводка и верхний предел ставки живут в `parsePortalSettings` — том же разборщике, который
// сервер повторяет на сохранении. Вторая схема на клиенте была бы вторым источником правды о том,
// что считается допустимой настройкой, и разошлась бы с сервером на первой же правке.

const model = defineModel<PortalMapping>({ required: true })

const props = defineProps<{
  /** Серверная копия настроек уже пришла (#408): до неё «ставки нет» и «настройки не загрузились» неразличимы. */
  loaded: boolean
  /** Админ портала — СЕРВЕРНЫЙ признак из `GET /api/settings`. Только для показа: разрешает сервер. */
  isAdmin: boolean
  /** Базовая валюта портала или `null`. Своей валюты у приложения нет и быть не может. */
  baseCurrency: string | null
  /** Прочитать валюту не удалось — это НЕ то же самое, что «валюты нет». */
  currencyUnknown: boolean
  /** Тристейт «мы в портале» (#408): `null` — рукопожатие ещё идёт. */
  inPortal: boolean | null
  /** Общая ошибка экрана (в основном — неудачное сохранение). */
  error: string
  /** Домен портала для ссылки «завести валюту». Пусто вне портала ⇒ ссылки нет. */
  portalDomain: string
}>()

// Supplier-article field: searchable picker over the portal's catalog product
// properties (P7). The model carries the property CODE (string); coerce the picker's
// `string | undefined` to the mapping's non-optional field.
const { fetcher: articleFetcher } = useCatalogProperties()
const articleField = computed<string | undefined>({
  get: () => model.value.article.field || undefined,
  set: (v) => { model.value.article.field = v ?? '' }
})
// Seed the picker's selected option so a SAVED code shows (as label) before the
// property list is fetched (lazy, on first open) — otherwise the field looks blank.
// On a real pick, capture the property's human label so it shows going forward.
const selectedArticle = ref<Record<string, unknown> | undefined>()
watch(() => model.value.article.field, (code) => {
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
  model.value.article.scope = scope === 'offer' ? 'offer' : 'product'
}

// Notify / error chat pickers (P3): search the portal's group chats via /api/chat-search.
// Both share one fetcher (same portal). The model stores the B24 DIALOG_ID `chat<id>`;
// clearing the picker (emits undefined) unsets the optional field so the worker skips it.
const { fetcher: chatFetcher } = useChatSearch()

// The model stores the B24 DIALOG_ID `chat<id>`; the optional field is unset (→ worker
// skips it) when the picker is cleared (emits '' / undefined).
const notifyChatId = computed<string | undefined>({
  get: () => model.value.notifyChatId || undefined,
  set: (v) => { model.value.notifyChatId = v || undefined }
})
const errorChatId = computed<string | undefined>({
  get: () => model.value.errorChatId || undefined,
  set: (v) => { model.value.errorChatId = v || undefined }
})

// Hourly rate for the «Сэкономлено денег» tile (#270). B24InputNumber, not a text field: it gives
// a numeric model plus min/max/step, so there is no string↔number layer to get wrong (a text field
// normalising on every keystroke ate the decimal separator mid-typing and made sub-1 rates
// unenterable). The CURRENCY is not chosen here — it is the portal's own base currency, resolved
// server-side. Empty/zero ⇒ the key is dropped and the dashboard shows time only.
const savingsRate = computed<number | undefined>({
  get: () => model.value.savings?.ratePerHour,
  // Coercion and the upper clamp stay in ONE place — the same parser the server re-applies on save.
  set: (v) => { model.value.savings = parsePortalSettings({ savings: { ratePerHour: v } }).savings }
})

// The rate is entered in the portal's BASE currency, and there is no field for it — so the code is
// shown next to the input. When the portal has none, the money tile can never appear no matter what
// is typed here (computeSavings drops the amount without a currency), so that case gets a red alert
// with a link to the portal's own currency settings instead of a silently missing tile.
const currencyLink = computed(() => portalCurrencySettingsUrl(props.portalDomain))

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
  props.baseCurrency
    ? {
        style: 'currency' as const,
        currency: props.baseCurrency,
        currencyDisplay: 'code' as const,
        // Currency style forces 2 decimals, so the field printed «9,90 BYN» under a hint saying
        // «9,9» — the same divergence the pinned locale exists to prevent, just one digit further
        // in. Both sides now drop a trailing zero and stop at hundredths.
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      }
    : undefined
)
const rateHint = computed(() => hourlyRateHint(props.baseCurrency))

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
watch([() => props.loaded, () => props.baseCurrency], () => {
  const seed = shouldPrefillRate({
    loaded: props.loaded,
    isAdmin: props.isAdmin,
    configured: isPortalConfigured(model.value),
    current: model.value.savings?.ratePerHour,
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
watch(() => model.value.notifyChatId, id => seedChat(selectedNotifyChat, id), { immediate: true })
watch(() => model.value.errorChatId, id => seedChat(selectedErrorChat, id), { immediate: true })

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
  unitRows.value = dictionaryToRows(model.value.units.dictionary).map(r => ({ id: nextRowId++, ...r }))
}
function addUnitRow() {
  unitRows.value.push({ id: nextRowId++, unit: '', code: null })
}
function removeUnitRow(id: number) {
  unitRows.value = unitRows.value.filter(r => r.id !== id)
}
// rows → dictionary (one direction only, so no reseed loop). Deep watch catches unit/code edits.
watch(unitRows, (rows) => {
  model.value.units.dictionary = rowsToDictionary(rows.map(r => ({ unit: r.unit, code: r.code })))
}, { deep: true })
const duplicateUnits = computed(() => hasDuplicateUnits(unitRows.value.map(r => ({ unit: r.unit, code: r.code }))))

// «Что уже работает» — из самой встроенной карты, чтобы подсказка не разъехалась с поведением.
const builtinUnitHint = BUILTIN_UNIT_HINT.join(', ')

// Default measure (when no unit matches): mapping.units.defaultCode is a number; the Select
// carries strings. Empty/invalid selection keeps the current default (never write NaN).
const defaultMeasure = computed<string>({
  get: () => String(model.value.units.defaultCode || 796),
  set: (v) => {
    const n = Number(v)
    if (Number.isInteger(n) && n > 0) model.value.units.defaultCode = n
  }
})

// Measure options as b24ui Select items (value = code string). Merge a synthetic «код N» entry
// for the current default and any row code NOT in the portal list, so a saved code still shows a
// value BEFORE the list loads (async) or if the measure was later deactivated on the portal
// (catalog.measure.list filters active:Y). The real label wins once loaded (same code → skipped).
const measureItems = computed(() => {
  const items = measures.value.map(m => ({ label: m.label, value: m.value }))
  const present = new Set(items.map(i => i.value))
  const referenced = new Set<string>([String(model.value.units.defaultCode || 796)])
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
  routingRows.value = rulesToRows(model.value.routingRules).map(r => ({ id: nextRuleId++, ...r }))
}
function addRoutingRow() {
  routingRows.value.push({ id: nextRuleId++, keywords: '', entityTypeId: null })
}
function removeRoutingRow(id: number) {
  routingRows.value = routingRows.value.filter(r => r.id !== id)
}
watch(routingRows, (rows) => {
  model.value.routingRules = rowsToRules(rows.map(r => ({ keywords: r.keywords, entityTypeId: r.entityTypeId, categoryId: r.categoryId, stageId: r.stageId, type: r.type })))
}, { deep: true })

// The default target ⇄ a TargetPicker model. The default target is always concrete (never «Авто»), so
// the picker is used with :include-auto="false"; a null emit (shouldn't happen without the Авто option)
// falls back to a deal so the default stays valid.
const defaultTargetModel = computed<TargetRef | null>({
  get: () => model.value.defaultTarget,
  set: (t) => { model.value.defaultTarget = t ?? { entityTypeId: 2 } }
})
// Per-rule target ⇄ TargetPicker: build a TargetRef from the row's fields and write the picked one back.
function rowTarget(row: EditableRoutingRow): TargetRef | null {
  return row.entityTypeId
    ? { entityTypeId: row.entityTypeId, ...(row.categoryId != null ? { categoryId: row.categoryId } : {}), ...(row.stageId ? { stageId: row.stageId } : {}) }
    : null
}
const toast = useToast()

/**
 * Маршрут в настройках стал негодным — СКАЗАТЬ, а не подменить молча (#492).
 *
 * ⚠ Пикер объявлял причину и раньше, но на этом экране её никто не слушал: направление или стадия
 * просто исчезали из формы, и ближайшее «Сохранить» записывало обрезанную настройку портала. То же
 * молчаливое искажение, что #488 объявил дефектом на экране импорта, только здесь оно портит не
 * одну пачку, а сохранённую конфигурацию.
 *
 * ⚠ Тост, а не строка в форме: пикеров на экране много (цель по умолчанию плюс каждое правило), и
 * место под сообщение у каждого из них превратило бы форму в частокол пустых мест.
 */
function onTargetInvalid(reason: 'entity' | 'category' | 'stage'): void {
  toast.add({
    // ⚠ `false` — «в «Авто» НЕ переключали»: в настройках цель сохраняется (#492), и общий текст про
    // «переключён на Авто» здесь был прямой неправдой о том, что записано в правиле (#500).
    title: targetInvalidMessage(reason, false),
    description: 'Негодное значение убрано из формы. Выберите новое и сохраните настройки.',
    color: 'air-primary-warning'
  })
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

/**
 * Пересев построчных редакторов — при КАЖДОЙ новой серверной копии настроек.
 *
 * ⚠ Строки словаря и правил засеиваются из настроек, а дальше САМИ являются источником правды:
 * обратная связь односторонняя (строки → настройки), иначе получилась бы петля. Поэтому у пересева
 * должен быть свой повод, и повод здесь — «пришли другие настройки»: первая загрузка и «Отмена»,
 * перечитывающая серверную копию. Без пересева отмена оставляла бы на экране правки, от которых
 * человек только что отказался.
 *
 * ⚠ Несущее допущение записано отдельно, потому что оно НЕ в этом файле: `useSettings.load()` и
 * `save()` ЗАМЕНЯЮТ объект настроек (`mapping.value = res.mapping`), а не правят его на месте —
 * поэтому смена ссылки и есть признак «пришла новая копия». Начни они мутировать объект — пересев
 * молча перестанет происходить, а выглядеть это будет как «редактор не показывает сохранённое».
 * Держит поведением `tests/nuxt/settingsForm.nuxt.test.ts`.
 *
 * ⚠ Прежде пересев звала СТРАНИЦА после `load()`. При разборе экрана (#523) это сломалось бы молча:
 * форма живёт под `ScreenState` и до прихода настроек ВООБЩЕ НЕ СМОНТИРОВАНА, то есть вызов уходил
 * бы в `null`, а редактор словаря оставался пустым при непустом словаре в портале.
 */
watch(model, () => {
  seedUnitRows()
  seedRoutingRows()
}, { immediate: true })

// Единицы портала — независимо от настроек, один раз: список нужен обоим выпадающим спискам.
void loadMeasures()
</script>

<template>
  <!-- Блоки-пары шаблона (#259): тонированная шапка + тело, вместе читаются как одна карточка.
       Скругления «rounded-none / sm:rounded-*-3xl» — как в референсе: на мобильном блок на всю
       ширину, на десктопе пара склеена. -->
  <div class="flex flex-col gap-4 sm:gap-6">
    <section
      :id="SECTIONS[0].id"
      class="scroll-mt-16"
    >
      <B24PageCard
        variant="tinted-no-accent"
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
            <p class="mb-2 text-xs text-(--ui-color-base-3)">
              Сюда попадут документы, для которых не сработало ни одно правило ниже — <b>и те, которые не удалось разобрать</b>. Приложение создаёт запись на каждую загрузку, даже неудачную: иначе такая загрузка не оставила бы в CRM никакого следа, и о ней узнали бы только случайно.
            </p>
            <TargetPicker
              v-model:target="defaultTargetModel"
              :include-auto="false"
              @invalid="onTargetInvalid"
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
                  @invalid="onTargetInvalid"
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
        variant="tinted-no-accent"
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
              clearable
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
              v-model="model.article.kind"
              :items="ARTICLE_KIND_ITEMS"
              orientation="horizontal"
            />
            <B24Input
              v-if="model.article.kind === 'string'"
              v-model="model.article.delimiter"
              placeholder="разделитель, например ;"
              class="mt-2 w-32"
            />
          </B24FormField>

          <!-- Стратегия товара -->
          <B24FormField :label="ON_MISSING_FIELD_LABEL">
            <B24Select
              v-model="model.product.onMissing"
              :b24ui="{ root: 'min-w-0 max-w-full' }"
              :items="ON_MISSING_ITEMS"
              class="w-full"
            />
            <!-- #373: у поля не было подсказки вовсе, а «пропустить» стояло первым в списке и
                 читалось как дефолт. На пустом каталоге оно пропускало ВЕСЬ документ.
                 ⚠ ТЕКСТ ИСПРАВЛЕН: он обещал, что «запись не создастся», — с #459 карточка
                 создаётся ВСЕГДА, включая неудачную загрузку. Это ТРЕТЬЕ место с одной и той же
                 неправдой (соседние — предупреждение на `/app` и текст отказа в
                 `importOutcome.ts`), и нашлось оно только сплошным обходом: точечная правка «по
                 указанию» закрыла два, а третье осталось бы и дало четвёртый заход владельца.
                 Правка поведения обязана тянуть за собой ревизию ВСЕХ текстов о нём. -->
            <p class="mt-1 text-xs text-(--ui-color-base-3)">
              По умолчанию строка вносится как есть. «Пропустить» подходит только при
              заполненном каталоге: если не найдётся ни один товар, импорт остановится с
              ошибкой, а карточка создастся пустой, с нулевой суммой.
            </p>
          </B24FormField>

          <!-- Единицы измерения -->
          <B24FormField label="Единицы измерения">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs text-(--ui-color-base-3)">Какую единицу подставить, если в документе встретилась незнакомая:</span>
              <B24Select
                v-model="defaultMeasure"
                :b24ui="{ root: 'min-w-0 max-w-full' }"
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
              <!-- ⚠ `flex-wrap` и `min-w-0` обязательны: без них строка «поле 10rem + поле
                   14rem + кнопка» шире телефона, а карточка не может стать уже своего
                   содержимого — на 375 px обрезался ВЕСЬ блок, включая соседние абзацы.
                   Наше же правило: никакой горизонтальной прокрутки. -->
              <div
                v-for="(row, i) in unitRows"
                :key="row.id"
                class="flex min-w-0 flex-wrap items-center gap-2"
              >
                <B24Input
                  v-model="row.unit"
                  placeholder="как в документе, напр. м"
                  class="w-full sm:w-40"
                  :aria-label="`Единица ${i + 1}: из документа`"
                />
                <span
                  class="text-(--ui-color-base-4)"
                  aria-hidden="true"
                >→</span>
                <B24Select
                  :b24ui="{ root: 'min-w-0 max-w-full' }"
                  :model-value="row.code != null ? String(row.code) : undefined"
                  :items="measureItems"
                  placeholder="единица в Б24"
                  class="w-full sm:w-56"
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
        variant="tinted-no-accent"
        :title="SECTIONS[2].label"
        :description="SECTIONS[2].description"
        :b24ui="{ root: 'rounded-none sm:rounded-t-3xl' }"
      />
      <B24PageCard
        variant="outline"
        :b24ui="{ root: 'rounded-none border-t-0 sm:rounded-b-3xl' }"
      >
        <div class="space-y-6">
          <!-- Чат уведомлений об успешном импорте -->
          <B24FormField label="Чат уведомлений">
            <AsyncSearchSelect
              v-model="notifyChatId"
              :fetcher="chatFetcher"
              :selected-option="selectedNotifyChat"
              :min-chars="3"
              clearable
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
              clearable
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
        variant="tinted-no-accent"
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
</template>
