<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
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
const props = defineProps<{ includeAuto?: boolean }>()

const { load: loadCrmCategories } = useCrmCategories()
const { load: loadCrmStages } = useCrmStages()
const { leadsEnabled, load: loadCrmMode } = useCrmMode()
const { types: smartProcesses, load: loadCrmTypes } = useCrmTypes()
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

const CHOICES = computed(() => buildEntityChoices(leadsEnabled.value, smartProcesses.value, props.includeAuto ?? true))
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
async function initCascade(): Promise<void> {
  if (etid.value == null) return
  const my = ++seq
  const nextCats = await loadCrmCategories(etid.value)
  if (my !== seq) return
  cats.value = nextCats
  const nextStages = await loadCrmStages(etid.value, categoryId.value ?? null)
  if (my !== seq) return
  stages.value = nextStages
}
async function chooseEntity(id: number | null): Promise<void> {
  const my = ++seq
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
      @click="() => chooseEntity(c.id)"
    />
    <B24Select
      v-if="showDirection"
      :model-value="catValue"
      :items="catItems"
      class="w-40"
      aria-label="Направление (воронка)"
      @update:model-value="onCategory"
    />
    <B24Select
      v-if="showStage"
      :model-value="stageValue"
      :items="stageItems"
      class="w-36"
      aria-label="Стадия"
      @update:model-value="onStage"
    />
  </div>
</template>
