<script setup lang="ts">
import { computed, ref } from 'vue'
import CrossMIcon from '@bitrix24/b24icons-vue/outline/CrossMIcon'
import { MAX_UPLOAD_FILES } from '~/utils/importUpload'
import type { TargetRef } from '~/types/mapping'

// Manual, one-by-one import staging (owner rework): picking files STAGES them into a list (no auto
// upload); each row carries its own «куда импортировать» target; a single «Импортировать» button then
// uploads them SEQUENTIALLY (no parallel load), showing a notification + per-row status — the page does
// NOT navigate to settings/metrics during import. Each successful upload becomes a job the «Последние
// операции» list below then follows.
//
// The `upload` transport is INJECTED from the parent's single useImport() instance (not created here) —
// so the page's job list + auto-poll follow the new jobs on the SAME reactive state; a second
// useImport() here would poll a separate, unwatched list and leak a timer on unmount.
type Status = 'queued' | 'uploading' | 'done' | 'error'
interface StagedFile { id: number, file: File, target: TargetRef | null, status: Status, error?: string }

const props = defineProps<{ upload: (file: File, target?: TargetRef | null) => Promise<boolean> }>()

const staged = ref<StagedFile[]>([])
let nextId = 1
const importing = ref(false)
const notice = ref('')

const picked = ref<File[] | null>(null)
/** Files still awaiting import (queued/uploading/error) — the cap counts these, «отправленные» don't. */
function pendingCount(): number {
  return staged.value.filter(s => s.status !== 'done').length
}
function onPicked(files: File[] | null | undefined): void {
  if (!files?.length) return
  // Cap the pending queue at MAX_UPLOAD_FILES (same bound the server batch uses) so a huge multi-select
  // doesn't build an unbounded one-by-one run. Excess is dropped with a notice — never silently.
  const room = MAX_UPLOAD_FILES - pendingCount()
  if (room <= 0) {
    notice.value = `В очереди уже максимум файлов (${MAX_UPLOAD_FILES}) — импортируйте или уберите часть.`
    picked.value = null
    return
  }
  const toAdd = files.slice(0, room)
  for (const f of toAdd) staged.value.push({ id: nextId++, file: f, target: null, status: 'queued' })
  if (toAdd.length < files.length) {
    notice.value = `Добавлено ${toAdd.length} из ${files.length}: очередь ограничена ${MAX_UPLOAD_FILES} файлами.`
  }
  picked.value = null
}
function remove(id: number): void {
  staged.value = staged.value.filter(s => s.id !== id)
}
function clearDone(): void {
  staged.value = staged.value.filter(s => s.status !== 'done')
}

const toImport = computed(() => staged.value.filter(s => s.status === 'queued' || s.status === 'error'))
const doneCount = computed(() => staged.value.filter(s => s.status === 'done').length)

const STATUS_LABEL: Record<Status, string> = {
  queued: 'в очереди',
  uploading: 'отправка…',
  done: 'отправлен',
  error: 'ошибка'
}
const STATUS_COLOR: Record<Status, 'air-secondary' | 'air-primary' | 'air-primary-success' | 'air-primary-alert'> = {
  queued: 'air-secondary',
  uploading: 'air-primary',
  done: 'air-primary-success',
  error: 'air-primary-alert'
}

async function startImport(): Promise<void> {
  if (importing.value) return
  const queue = toImport.value
  if (!queue.length) return
  importing.value = true
  let ok = 0
  let attempted = 0
  // ONE BY ONE — sequential, no parallel load (owner ask: «мне нагрузка не нужна»).
  for (const s of queue) {
    // The user can still click «убрать» on a not-yet-processed (queued) row while the loop runs —
    // its remove button is visible until it starts uploading. Skip any row that left the staged
    // list so a removed file is NOT uploaded from this snapshot.
    if (!staged.value.includes(s)) continue
    attempted++
    s.status = 'uploading'
    s.error = undefined
    notice.value = `Импортируем «${s.file.name}»…`
    const success = await props.upload(s.file, s.target)
    if (success) {
      s.status = 'done'
      ok++
    } else {
      s.status = 'error'
      s.error = 'не удалось отправить'
    }
  }
  importing.value = false
  notice.value = `Отправлено в CRM: ${ok} из ${attempted}. Статус обработки — ниже, в «Последние операции».`
}
</script>

<template>
  <div>
    <!-- Dropzone STAGES files (no auto-upload). -->
    <B24FileUpload
      v-model="picked"
      multiple
      accept=".pdf,.png,.jpg,.jpeg,.xlsx,.xls,.docx"
      :disabled="importing"
      size="lg"
      label="Перетащите файл(ы) сюда или нажмите"
      description="PDF, фото, Excel, Word · до 20 МБ · импорт по кнопке ниже"
      @update:model-value="onPicked"
    />

    <!-- Staged list: each file + its own «куда импортировать» + status. -->
    <B24Card
      v-if="staged.length"
      variant="outline"
      class="mt-3"
      :b24ui="{ body: 'p-0 sm:p-0' }"
    >
      <ul class="divide-y divide-(--ui-color-base-5)">
        <li
          v-for="s in staged"
          :key="s.id"
          class="flex flex-col gap-2 p-3"
        >
          <div class="flex items-center justify-between gap-3">
            <p class="min-w-0 flex-1 truncate text-sm font-medium">
              {{ s.file.name }}
            </p>
            <div class="flex shrink-0 items-center gap-2">
              <B24Badge
                :label="STATUS_LABEL[s.status]"
                :color="STATUS_COLOR[s.status]"
                size="sm"
              />
              <B24Button
                v-if="s.status !== 'uploading' && s.status !== 'done'"
                :icon="CrossMIcon"
                color="air-tertiary-no-accent"
                size="xs"
                :aria-label="`Убрать ${s.file.name}`"
                @click="() => remove(s.id)"
              />
            </div>
          </div>
          <!-- Per-file target; hidden once uploaded. -->
          <div
            v-if="s.status === 'queued' || s.status === 'error'"
            class="flex flex-wrap items-center gap-2"
          >
            <span class="text-xs text-(--ui-color-base-4)">Куда:</span>
            <TargetPicker v-model:target="s.target" />
          </div>
          <p
            v-if="s.error"
            class="text-xs text-(--ui-color-accent-main-alert)"
          >
            {{ s.error }}
          </p>
        </li>
      </ul>
    </B24Card>

    <!-- Action row: manual start + clear-done. -->
    <div
      v-if="staged.length"
      class="mt-3 flex flex-wrap items-center gap-2"
    >
      <B24Button
        color="air-primary"
        :loading="importing"
        :disabled="importing || !toImport.length"
        :label="importing ? 'Импорт…' : `Импортировать${toImport.length ? ` (${toImport.length})` : ''}`"
        @click="startImport"
      />
      <B24Button
        v-if="doneCount"
        label="Убрать отправленные"
        color="air-tertiary-no-accent"
        size="sm"
        :disabled="importing"
        @click="clearDone"
      />
    </div>

    <!-- Notification (instead of navigating to settings/metrics). -->
    <B24Alert
      v-if="notice"
      class="mt-3"
      :color="importing ? 'air-primary' : 'air-primary-success'"
      size="sm"
      :title="notice"
      role="status"
    />
  </div>
</template>
