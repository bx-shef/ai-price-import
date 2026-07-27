<script setup lang="ts">
import { computed, ref } from 'vue'
import CrossMIcon from '@bitrix24/b24icons-vue/outline/CrossMIcon'
import { MAX_UPLOAD_FILES, UPLOAD_ACCEPT, validateUploadFile } from '~/utils/importUpload'
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
interface StagedFile {
  id: number
  /** Stable idempotency key (desired jobId) reused across retries. */
  key: string
  file: File
  target: TargetRef | null
  status: Status
  error?: string
  /** Pre-validation failure (bad extension/size) → shown as error but NOT retryable/uploadable. */
  invalid?: boolean
}

const props = defineProps<{ upload: (file: File, target?: TargetRef | null, jobId?: string) => Promise<boolean> }>()

const staged = ref<StagedFile[]>([])
let nextId = 1
const importing = ref(false)
const notice = ref('')

/** Stable idempotency key per staged file → reused across retries so a re-upload can't create a second
 *  CRM entity (the server keys the job on it). ALWAYS a valid v4 UUID (uuidv4 has non-crypto fallbacks) —
 *  a non-UUID key would be rejected server-side and desync the client job record (see uuid.ts). */
function newKey(): string {
  return uuidv4()
}
/** Loose identity of a picked File (same file picked twice = same signature) for dedup. */
function sig(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`
}

// File input is a PLAIN native <input type="file"> (like the landing demo), NOT b24ui's B24FileUpload:
// on mobile the native picker lets the OS offer «Файлы / Фото / Камера», while B24FileUpload's JS-driven
// useFileDialog did NOT surface the camera on the phone. `dragging` toggles the dropzone highlight.
const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
/** Native <input change>: collect the chosen files → stage them; reset value so the SAME file can be
 *  re-picked (change doesn't fire otherwise). */
function onInputChange(e: Event): void {
  const input = e.target as HTMLInputElement
  onPicked(input.files ? Array.from(input.files) : [])
  input.value = ''
}
/** Drag-drop onto the dropzone label → stage the dropped files. */
function onDrop(e: DragEvent): void {
  dragging.value = false
  if (importing.value) return
  onPicked(e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [])
}

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
    return
  }
  const known = new Set(staged.value.map(s => sig(s.file)))
  let added = 0
  let dupes = 0
  for (const f of files) {
    if (added >= room) break
    // Dedup: the same file staged twice would import twice (each upload = a distinct job the server
    // can't dedup) → skip it. The staged row for the first copy is already visible.
    if (known.has(sig(f))) {
      dupes++
      continue
    }
    known.add(sig(f))
    // Pre-validate on stage (extension/size): a bad file becomes an 'error' row with the reason and is
    // NOT queued for upload (invalid=true excludes it from toImport) — the operator sees why immediately.
    const v = validateUploadFile({ name: f.name, size: f.size })
    staged.value.push(v.ok
      ? { id: nextId++, key: newKey(), file: f, target: null, status: 'queued' }
      : { id: nextId++, key: newKey(), file: f, target: null, status: 'error', error: v.error, invalid: true })
    added++
  }
  const notes: string[] = []
  if (dupes) notes.push(`${dupes} уже в списке — пропущены`)
  if (added < files.length - dupes) notes.push(`очередь ограничена ${MAX_UPLOAD_FILES} файлами`)
  notice.value = notes.length ? `Добавлено ${added} из ${files.length}: ${notes.join('; ')}.` : ''
}
function remove(id: number): void {
  staged.value = staged.value.filter(s => s.id !== id)
}
function clearDone(): void {
  staged.value = staged.value.filter(s => s.status !== 'done')
}

// Uploadable rows: queued, or a retryable error (a network failure) — but NOT a pre-validation
// failure (invalid), which can never succeed and must not be re-sent.
const toImport = computed(() => staged.value.filter(s => s.status === 'queued' || (s.status === 'error' && !s.invalid)))
const doneCount = computed(() => staged.value.filter(s => s.status === 'done').length)

const STATUS_LABEL: Record<Status, string> = {
  queued: 'В очереди',
  uploading: 'Отправка…',
  done: 'Отправлен',
  error: 'Ошибка'
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
    // Pass the row's stable key as the desired jobId → a retry of THIS row reuses it and can't create
    // a duplicate CRM entity (server keys the job on it; crm-sync marker dedups).
    const success = await props.upload(s.file, s.target, s.key)
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
    <!-- Dropzone STAGES files (no auto-upload). PLAIN native <input type=file> (like the landing demo)
         so the mobile OS offers «Файлы / Фото / Камера» — b24ui's B24FileUpload didn't surface the
         camera. Styled with semantic --ui-color-* tokens → light/dark-auto. -->
    <label
      class="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors"
      :class="[
        importing ? 'pointer-events-none opacity-60' : '',
        dragging ? 'border-(--ui-color-accent-main-primary) bg-(--ui-color-accent-main-primary)/5' : 'border-(--ui-color-base-5) hover:border-(--ui-color-accent-main-primary)'
      ]"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <span class="text-sm font-medium text-(--ui-color-base-1)">
        Перетащите файл(ы) или нажмите — выберите файл или сделайте фото
      </span>
      <span class="text-xs text-(--ui-color-base-3)">
        PDF, фото, Excel, Word · до 20 МБ · импорт по кнопке ниже
      </span>
      <input
        ref="fileInput"
        type="file"
        multiple
        :accept="UPLOAD_ACCEPT"
        :disabled="importing"
        class="hidden"
        @change="onInputChange"
      >
    </label>

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
          <!-- Per-file target; shown only for uploadable rows (hidden once uploaded / for invalid files). -->
          <div
            v-if="!s.invalid && (s.status === 'queued' || s.status === 'error')"
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
