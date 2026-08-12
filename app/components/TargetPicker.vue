<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useCrmCategories } from '~/composables/useCrmCategories'
import { useCrmStages } from '~/composables/useCrmStages'
import { useCrmMode } from '~/composables/useCrmMode'
import { useCrmTypes } from '~/composables/useCrmTypes'
import * as catPicker from '~/utils/categoryPicker'
import * as stagePicker from '~/utils/stagePicker'
import { autoPickSingleCategory, buildEntityChoices, directionApplies, smartProcessByEtid, stageApplies } from '~/utils/targetOptions'
import type { CrmCategoryOption } from '~/utils/categoryPicker'
import type { CrmStageOption } from '~/utils/stagePicker'
import type { TargetRef } from '~/types/mapping'
import { targetInvalidMessage, targetInvalidReason, type TargetInvalidReason } from '~/utils/targetValidity'

// Compact «куда импортировать» picker — reusable PER FILE and shared with /settings (via the same pure
// rules in ~/utils/targetOptions). Default «Авто (по правилам)» (null target = follow routing rules).
// Entity → direction (воронка) → stage cascade loaded lazily. Emits the resolved TargetRef | null.
//
// Entity list = Авто → Лид (only if leads enabled) → Сделка → Смарт-счёт → each SMART PROCESS by name
// (crm.type.list — no raw entityTypeId input). Direction/stage pickers show per the entity's real rules:
// deal has both; lead only a stage; smart-invoice only a stage (its single direction is auto-used); a
// smart process shows direction/stage only when it actually uses them (isCategoriesEnabled/isStagesEnabled).
const target = defineModel<TargetRef | null>('target', { default: null })
// `includeAuto` adds the «Авто (по правилам)» option — on the per-file import picker (default true).
// The settings page (default target + routing rules) passes false: those targets are always concrete.
// NB: Vue casts an ABSENT Boolean prop to `false` (not undefined), so the per-file import picker's
// «Авто» default must be set explicitly via withDefaults — a `?? true` fallback would never fire.
// `disabled` — на время идущей пачки (#443): цель ОДНА на пачку и заморожена на время прогона, и
// до этой правки заморозка держалась на `pointer-events-none` у обёртки, то есть только для мыши —
// с клавиатуры выбор менялся, и следующие файлы пачки уехали бы в другое место. Проп проходит в сами
// поля, а не гасит обёртку: браузер сам убирает их из порядка обхода.
const props = withDefaults(defineProps<{ includeAuto?: boolean, disabled?: boolean }>(), { includeAuto: true, disabled: false })
// ⚠ О негодном маршруте пикер СООБЩАЕТ наверх, а не чинит его молча (#488): раньше удалённые
// направление и стадия дочищались тихо, человек видел в полях другое значение и не знал, почему.
// Показать сообщение — дело владельца состояния (карточки загрузки), а не выпадающего списка.
const emitInvalid = defineEmits<{ invalid: [reason: TargetInvalidReason] }>()

const { load: loadCrmCategories } = useCrmCategories()
const { load: loadCrmStages } = useCrmStages()
const { leadsEnabled, load: loadCrmMode } = useCrmMode()
const { types: smartProcesses, smartInvoiceEnabled, typesLoaded, load: loadCrmTypes } = useCrmTypes()
onMounted(() => {
  void loadCrmMode()
  void loadCrmTypes()
  void initCascade() // pre-load direction/stage lists for an ALREADY-set target (editing in settings)
})

const etid = ref<number | null>(target.value?.entityTypeId ?? null)
const categoryId = ref<number | undefined>(target.value?.categoryId)
const stageId = ref<string | undefined>(target.value?.stageId)
const cats = ref<CrmCategoryOption[] | undefined>(undefined)
const stages = ref<CrmStageOption[] | undefined>(undefined)

const CHOICES = computed(() => buildEntityChoices(smartProcesses.value, {
  leadsEnabled: leadsEnabled.value,
  smartInvoiceEnabled: smartInvoiceEnabled.value,
  includeAuto: props.includeAuto
}))
const spByEtid = computed(() => smartProcessByEtid(smartProcesses.value))
const currentSp = computed(() => (etid.value != null ? spByEtid.value.get(etid.value) : undefined))

function emit(): void {
  target.value = etid.value
    ? {
        entityTypeId: etid.value,
        ...(categoryId.value != null ? { categoryId: categoryId.value } : {}),
        ...(stageId.value ? { stageId: stageId.value } : {})
      }
    : null
}

// Guards against out-of-order cascade responses: each entity/category change bumps `seq`; an
// awaited fetch that resolves after a newer change is dropped (its `my !== seq`).
let seq = 0

async function reloadStages(token: number): Promise<void> {
  stageId.value = undefined
  const next = etid.value ? await loadCrmStages(etid.value, categoryId.value ?? null) : undefined
  if (token !== seq) return // superseded → drop stale response
  stages.value = next
  emit()
}
// Load the direction/stage lists for an ALREADY-set target (e.g. a saved routing rule opened in
// settings) WITHOUT clearing the stored categoryId/stageId — so the pickers show the current values
// instead of appearing empty until the user re-picks the entity.
/**
 * Что у выбранного маршрута перестало существовать — `null`, пока всё в порядке.
 *
 * ⚠ Это ЕДИНСТВЕННЫЙ детектор (#500). Раньше их было два: сторож исчезнувшей СУЩНОСТИ (#269) и
 * правило про направление и стадию (#488). Они расходились в том, что делают (#269 на `/settings`
 * молча превращал смарт-счёт админа в сделку, #488 цель берёг) и в том, чем сообщают (постоянная
 * строка против всплывающего сообщения), а ветка `'entity'` общего правила была НЕДОСТИЖИМА — оба
 * вызова передавали `entityIds: undefined`. Мёртвая ветка с комментарием про работающую проверку
 * читается как действующий механизм, и это опаснее её отсутствия.
 */
const invalidReason = ref<TargetInvalidReason | null>(null)

// A target saved earlier can point at a type the portal no longer offers (smart invoices switched off,
// smart process deleted). Hiding it from CHOICES is not enough: `etid` would keep the stale id, the
// select would look empty, and the same id would still be emitted and saved — the import would fail
// exactly as before the fix (#269).
watch([CHOICES, () => etid.value], () => {
  const id = etid.value
  if (id == null) return
  // Smart processes arrive asynchronously — don't drop a valid one just because the list is empty yet.
  // ⚠ Признак — «список получен» (`typesLoaded`), а не «список непустой»: у портала со стёртым
  // смарт-процессом и без единого другого список ПУСТ и после загрузки, и прежняя проверка защищала
  // такой id вечно — то есть #269 на этом портале не работал вовсе.
  // ⚠ Отсюда же и `entityIds: undefined` до загрузки: незагруженное НИКОГДА не читается как «не
  // существует» — иначе на медленной сети исправный маршрут объявлялся бы негодным. Fail-open здесь
  // несущий, и при сведении механизмов его легче всего было потерять.
  // ⚠ «Авто» (`id: null`) — не тип записи, и в список доступных типов не входит: иначе `null` попал
  // бы в сравнение и «Авто» считалось бы существующей сущностью.
  const entityIds = typesLoaded.value
    ? CHOICES.value.map(c => c.id).filter((v): v is number => v != null)
    : undefined
  if (targetInvalidReason({ entityTypeId: id }, { entityIds, categoryIds: undefined, stageIds: undefined }) !== 'entity') return
  failToAuto('entity')
})
/**
 * Увести выбор в «Авто» и объявить причину. Порядок важен: сначала состояние, потом сообщение —
 * обработчик наверху вправе смотреть на модель.
 *
 * ⚠ Сюда идут ВСЕ три причины, включая исчезнувшую сущность (#500). Прежде у неё был свой путь со
 * своим поведением и своим носителем сообщения.
 *
 * ⚠ А направление и стадию до этой правки дочищали МОЛЧА: поле показывало другое значение без
 * объяснения, и следующая пачка уходила не туда, куда человек рассчитывал (#488).
 */
function failToAuto(reason: TargetInvalidReason): void {
  // ⚠ Тип обнуляем ТОЛЬКО там, где «Авто» вообще предлагается (#492). На `/settings` цели всегда
  // конкретны, и `null` там означает не «решают правила», а «цель не задана»: сеттер по умолчанию
  // подставит голую сделку, то есть смарт-счёт или смарт-процесс админа МОЛЧА превратится в
  // сделку, а правило маршрутизации потеряет цель. Это было бы то же самое молчаливое искажение,
  // которое #488 объявил дефектом, только перенесённое на экран настроек, где цена выше: там
  // портится сохранённая конфигурация портала, а не выбор одной пачки.
  // ⚠ Сообщение (`invalid`) шлём в ОБОИХ случаях: сказать человеку надо всегда, а вот трогать его
  // сохранённую настройку — нет.
  // ⚠ Оговорка распространена и на исчезнувшую СУЩНОСТЬ (#500): прежний сторож подменял её сделкой
  // даже в настройках, то есть делал ровно то молчаливое искажение, которое запрещено абзацем выше.
  if (props.includeAuto) {
    etid.value = null
    cats.value = undefined
    stages.value = undefined
    categoryId.value = undefined
  } else if (reason === 'category') {
    // ⚠ Снимаем ТОЛЬКО то, что негодно. Ветка 'stage' означает, что направление проверку прошло, и
    // обнулять его заодно — потерять годную настройку админа за компанию с негодной.
    categoryId.value = undefined
  }
  stageId.value = undefined
  invalidReason.value = reason
  emit()
  emitInvalid('invalid', reason)
}

async function initCascade(): Promise<void> {
  if (etid.value == null) return
  const my = ++seq
  const nextCats = await loadCrmCategories(etid.value)
  if (my !== seq) return
  cats.value = nextCats
  // ⚠ ПРОВЕРКА ИДЁТ ДО тихой дочистки ниже: та снимает негодное значение, и после неё отличить
  // «направление удалили» от «его и не было» уже нечем — сообщение человеку стало бы невозможным.
  if (categoryId.value != null && targetInvalidReason(
    { entityTypeId: etid.value, categoryId: categoryId.value },
    { entityIds: undefined, categoryIds: nextCats?.map(c => c.id), stageIds: undefined }
  ) === 'category') {
    failToAuto('category')
    // ⚠ НЕ выходим из функции: на `/settings` тип остаётся выбранным, и без загрузки стадий блок
    // «Стадия» просто не нарисуется — админ увидит, что направление исчезло, а стадии нет вовсе, без
    // объяснения. Раньше `return` был безвреден, потому что тип обнулялся вместе с направлением.
    if (props.includeAuto) return
    const fallbackStages = await loadCrmStages(etid.value, null)
    if (my !== seq) return
    stages.value = fallbackStages
    return
  }
  // Reconcile a STALE direction: if the saved categoryId no longer exists on the portal (funnel
  // deleted), clear it so the picker doesn't show a dangling value and a bad id isn't re-saved.
  const before = { categoryId: categoryId.value, stageId: stageId.value }
  const catT = { entityTypeId: etid.value, categoryId: categoryId.value }
  catPicker.reconcileCategory(catT, nextCats)
  categoryId.value = catT.categoryId
  const nextStages = await loadCrmStages(etid.value, categoryId.value ?? null)
  if (my !== seq) return
  stages.value = nextStages
  if (stageId.value != null && targetInvalidReason(
    { entityTypeId: etid.value, stageId: stageId.value },
    { entityIds: undefined, categoryIds: undefined, stageIds: nextStages?.map(s => s.id) }
  ) === 'stage') return failToAuto('stage')
  // Reconcile a STALE stage likewise.
  const stageT = { stageId: stageId.value }
  stagePicker.reconcileStage(stageT, nextStages)
  stageId.value = stageT.stageId
  if (before.categoryId !== categoryId.value || before.stageId !== stageId.value) emit()
}
async function chooseEntity(id: number | null): Promise<void> {
  const my = ++seq
  // Человек выбрал сам — прежняя жалоба перестала описывать то, что на экране.
  invalidReason.value = null
  etid.value = id
  categoryId.value = undefined
  stageId.value = undefined
  stages.value = undefined
  // Commit the chosen entity to the model IMMEDIATELY — before the async cascade resolves.
  emit()
  const nextCats = id ? await loadCrmCategories(id) : undefined
  if (my !== seq) return // superseded by a newer entity pick
  cats.value = nextCats
  // When the direction picker is HIDDEN but the entity still addresses stages by category (smart-invoice,
  // or a category-less SPA with stages), silently auto-pick the single/first category so the stage list
  // can load (its stageEntityId needs a category).
  if (autoPickSingleCategory(id, spByEtid.value.get(id ?? -1)) && nextCats?.length) {
    // Direction is hidden (e.g. smart-invoice = «always one»); use the sole category. If the portal
    // unexpectedly has MORE than one, warn — we silently take the first, which may not be the intended
    // one (the direction picker is hidden by design, so the user can't choose).
    if (nextCats.length > 1) console.warn(`[TargetPicker] entity ${id} has ${nextCats.length} directions but the picker is hidden — using the first («${nextCats[0]!.name ?? nextCats[0]!.id}»)`)
    categoryId.value = nextCats[0]!.id
    emit()
  }
  await reloadStages(my)
}
const catItems = computed(() => catPicker.categoryItems(cats.value))
// Show the direction picker only when the entity's rules allow it AND categories actually loaded.
const showDirection = computed(() => directionApplies(etid.value, currentSp.value) && catPicker.hasCategories(cats.value))
const catValue = computed(() => catPicker.categoryValue({ categoryId: categoryId.value ?? undefined }))
async function onCategory(v: unknown): Promise<void> {
  const t: { categoryId?: number } = { categoryId: categoryId.value }
  catPicker.setCategory(t, v)
  categoryId.value = t.categoryId
  emit() // commit the direction immediately (stage cascade may still be loading)
  await reloadStages(++seq)
}
const stageItems = computed(() => stagePicker.stageItems(stages.value))
// Show the stage picker only when the entity's rules allow it AND stages actually loaded.
const showStage = computed(() => stageApplies(etid.value, currentSp.value) && stagePicker.hasStages(stages.value))
const stageValue = computed(() => stagePicker.stageValue({ stageId: stageId.value ?? undefined }))
function onStage(v: unknown): void {
  const t: { stageId?: string } = { stageId: stageId.value }
  stagePicker.setStage(t, v)
  stageId.value = t.stageId
  emit()
}
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-1.5"
    role="group"
    aria-label="Куда импортировать"
  >
    <B24Button
      v-for="c in CHOICES"
      :key="String(c.id)"
      :label="c.label"
      size="xs"
      :color="etid === c.id ? 'air-primary' : 'air-tertiary-no-accent'"
      :aria-pressed="etid === c.id"
      :disabled="props.disabled"
      @click="() => chooseEntity(c.id)"
    />
    <!-- ⚠ ДВА носителя одного сообщения, и это решение, а не случайность (#500). Всплывающее
         сообщение (событие `invalid` → тост у родителя) ловит внимание в момент, когда цель
         сменилась; эта строка остаётся после того, как тост погас, и стоит у самого места выбора —
         без неё человек, отошедший от компьютера, возвращался бы к изменившемуся выбору без
         единого объяснения. Прежде носитель зависел от ПРИЧИНЫ: у исчезнувшей сущности была строка,
         у направления и стадии — тост, то есть одна и та же беда выглядела по-разному.
         ⚠ Частокол пустых мест форме не грозит: строка рисуется по `v-if` и только у того пикера,
         чей маршрут действительно сломался. -->
    <p
      v-if="invalidReason"
      class="w-full text-xs text-(--ui-color-accent-main-warning)"
      role="status"
    >
      {{ targetInvalidMessage(invalidReason, props.includeAuto) }}
    </p>
    <B24Select
      v-if="showDirection"
      :model-value="catValue"
      :items="catItems"
      class="w-40"
      :disabled="props.disabled"
      aria-label="Направление (воронка)"
      @update:model-value="onCategory"
    />
    <B24Select
      v-if="showStage"
      :model-value="stageValue"
      :items="stageItems"
      class="w-36"
      :disabled="props.disabled"
      aria-label="Стадия"
      @update:model-value="onStage"
    />
  </div>
</template>
