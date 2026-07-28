<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useCrmCategories } from '~/composables/useCrmCategories'
import { useCrmStages } from '~/composables/useCrmStages'
import { useCrmMode } from '~/composables/useCrmMode'
import * as catPicker from '~/utils/categoryPicker'
import * as stagePicker from '~/utils/stagePicker'
import type { CrmCategoryOption } from '~/utils/categoryPicker'
import type { CrmStageOption } from '~/utils/stagePicker'
import type { TargetRef } from '~/types/mapping'

// Compact «куда импортировать» picker — reusable PER FILE (extracted from the old global /app override).
// Default «Авто (по правилам)» (null target = follow the portal's routing rules). Entity → direction
// (воронка) → stage cascade loaded lazily FROM the portal only when the user picks a concrete entity —
// so N staged files don't each fire cascade fetches until actually customised. Emits the resolved
// TargetRef | null via v-model:target.
const target = defineModel<TargetRef | null>('target', { default: null })

const { load: loadCrmCategories } = useCrmCategories()
const { load: loadCrmStages } = useCrmStages()

const etid = ref<number | null>(target.value?.entityTypeId ?? null)
const categoryId = ref<number | undefined>(target.value?.categoryId)
const stageId = ref<string | undefined>(target.value?.stageId)
const cats = ref<CrmCategoryOption[] | undefined>(undefined)
const stages = ref<CrmStageOption[] | undefined>(undefined)

// Hide «Лид» on a no-leads (simple CRM) portal — a lead there is auto-converted at once, so offering it
// is misleading (crm-sync would redirect it to a deal anyway). Loaded once via useCrmMode (frame token).
const { leadsEnabled, load: loadCrmMode } = useCrmMode()
onMounted(() => void loadCrmMode())
const ALL_CHOICES: Array<{ id: number | null, label: string }> = [
  { id: null, label: 'Авто (по правилам)' },
  { id: 1, label: 'Лид' },
  { id: 2, label: 'Сделка' },
  { id: 31, label: 'Смарт-счёт' }
]
const CHOICES = computed(() => ALL_CHOICES.filter(c => c.id !== 1 || leadsEnabled.value))

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
// awaited fetch that resolves after a newer change is dropped (its `my !== seq`), so cats/stages
// can't end up mismatched with the current entity (legacy `runSeq` pattern).
let seq = 0

async function reloadStages(token: number): Promise<void> {
  stageId.value = undefined
  const next = etid.value ? await loadCrmStages(etid.value, categoryId.value ?? null) : undefined
  if (token !== seq) return // superseded → drop stale response
  stages.value = next
  emit()
}
async function chooseEntity(id: number | null): Promise<void> {
  const my = ++seq
  etid.value = id
  categoryId.value = undefined
  stageId.value = undefined
  stages.value = undefined
  // Commit the chosen entity to the model IMMEDIATELY — before the (async) direction/stage cascade
  // resolves — so an import fired during the load window uploads with the right target, not a stale/
  // null one.
  emit()
  const nextCats = id ? await loadCrmCategories(id) : undefined
  if (my !== seq) return // superseded by a newer entity pick
  cats.value = nextCats
  await reloadStages(my)
}
const catItems = computed(() => catPicker.categoryItems(cats.value))
const showDirection = computed(() => catPicker.hasCategories(cats.value))
const catValue = computed(() => catPicker.categoryValue({ categoryId: categoryId.value ?? undefined }))
async function onCategory(v: unknown): Promise<void> {
  const t: { categoryId?: number } = { categoryId: categoryId.value }
  catPicker.setCategory(t, v)
  categoryId.value = t.categoryId
  emit() // commit the direction immediately (stage cascade may still be loading)
  await reloadStages(++seq)
}
const stageItems = computed(() => stagePicker.stageItems(stages.value))
const showStage = computed(() => stagePicker.hasStages(stages.value))
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
    <B24InputNumber
      :model-value="etid"
      :min="1"
      class="w-20"
      aria-label="ID типа целевой сущности (смарт-процесс ≥ 1000)"
      @update:model-value="(v: unknown) => chooseEntity(typeof v === 'number' && v > 0 ? v : null)"
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
