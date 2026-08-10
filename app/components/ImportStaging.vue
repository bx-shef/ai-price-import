<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CrossMIcon from '@bitrix24/b24icons-vue/outline/CrossMIcon'
import AttachIcon from '@bitrix24/b24icons-vue/outline/AttachIcon'
import { MAX_UPLOAD_FILES, UPLOAD_ACCEPT, UPLOAD_GENERIC_ERROR, formatBytes, validateUploadFile, type UploadOutcome } from '~/utils/importUpload'
import { FORMATS_HUMAN } from '~/config/uploadFormats'
import { MAX_ITEMS } from '~/utils/extractedDocument'
import { pluralRu, type JobStatus } from '~/utils/jobStatus'
import type { TargetRef } from '~/types/mapping'
import { readTarget, targetMemoryKey, writeTarget } from '~/utils/targetMemory'
import { targetInvalidMessage, type TargetInvalidReason } from '~/utils/targetValidity'

// Batch import staging (owner rework, round 2): pick files, choose ONE target for the whole batch,
// press «Импортировать». The button LOCKS the page (via update:busy), uploads the files, then WAITS
// until every accepted job reaches a terminal state — results appear in «Последние операции» below as
// they finish — and only then unlocks. A visible banner says the page must stay open: the job list
// lives in page memory only (no localStorage — owner ask), so a closed tab loses the run.
//
// «Отменить» stops the run: files not yet uploaded stay staged, and the page stops WAITING for the
// ones already sent. It does not — cannot — recall them: the server has accepted those jobs and will
// finish them; their results still land in the list below. The notice says exactly that, because a
// cancel that silently keeps writing to the CRM would read as a lie.
//
// A file that fails mid-batch shows its problem on its row and the batch MOVES ON (owner ask) — the
// only exception is the rate-limit refusal, which is about the operator, not the file: every next row
// would hit the same wall, so that one still stops the run.
//
// The `upload`/`jobDone` transport is INJECTED from the parent's single useImport() instance — a
// second useImport() here would poll a separate, unwatched list and leak a timer on unmount.
type Status = 'queued' | 'uploading' | 'sent' | 'error'
interface StagedFile {
  id: number
  /** Stable idempotency key (desired jobId) reused across retries. */
  key: string
  file: File
  status: Status
  error?: string
  /** Pre-validation failure (bad extension/size) → shown as error but NOT retryable/uploadable. */
  invalid?: boolean
}

const props = defineProps<{
  upload: (file: File, target?: TargetRef | null, jobId?: string) => Promise<UploadOutcome>
  /** Portal domain — the remembered target is scoped to it (#349). */
  portalDomain?: string
  /** Terminal status of a job accepted by the server, or null while it is still being processed. */
  jobDone: (jobId: string) => JobStatus | null
  /** Restart the parent's status polling (it self-stops after MAX_POLL_FAILURES). The wait phase
   *  depends on that poll — without a revive hook a dead poll meant waiting forever in silence. */
  refreshNow: () => Promise<void>
  /** The parent's last poll error, '' when polling is healthy. Shown during the wait so a dead
   *  connection is not mistaken for a slow portal. */
  listError: string
}>()
// Surface the «идёт импорт» state to the parent so it can BLOCK the rest of the UI while the run is
// in flight — the operator shouldn't touch settings/metrics mid-run (owner ask).
const emit = defineEmits<{ 'update:busy': [boolean] }>()

/** «10 000», а не «10000»: длинное число без разделителя читается как случайный набор цифр. */
const maxItemsHuman = MAX_ITEMS.toLocaleString('ru-RU')

// Сообщения о негодном маршруте — тостом b24ui (layout `clear` держит `B24App`, он их и рендерит).
const toast = useToast()

const staged = ref<StagedFile[]>([])
let nextId = 1
const importing = ref(false)
watch(importing, v => emit('update:busy', v)) // notify the parent to lock/unlock the rest of the UI
const notice = ref('')
// ONE target for the whole batch (owner ask — per-file pickers dropped): chosen while staging,
// frozen for the duration of the run.
//
// Remembered for the TAB (#349, sessionStorage — see app/utils/targetMemory.ts): a person importing
// invoices all day sends them to the same place, and re-picking сущность → направление → стадию on
// every batch was pure friction. Only identifiers are stored, keyed by the portal domain, and the
// memory dies with the tab — a shared office computer keeps nothing for the next person.
const target = ref<TargetRef | null>(null)
const memoryKey = computed(() => targetMemoryKey(props.portalDomain))

onMounted(() => {
  if (typeof window === 'undefined') return
  // TargetPicker re-reads the live cascade and clears anything that no longer exists, so a deleted
  // or renamed направление cannot resurrect here — the restored value is a suggestion, not truth.
  const restored = readTarget(window.sessionStorage, memoryKey.value)
  if (restored) target.value = restored
})

// No `deep` — TargetRef is a flat object of primitives and the picker always assigns a NEW one.
watch(target, (t) => {
  if (typeof window === 'undefined') return
  writeTarget(window.sessionStorage, memoryKey.value, t)
})
// Set by «Отменить»; checked between uploads and inside the wait loop.
const cancelled = ref(false)

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

function onPicked(files: File[] | null | undefined): void {
  if (!files?.length) return
  // Cap the pending queue at MAX_UPLOAD_FILES (same bound the server batch uses) so a huge multi-select
  // doesn't build an unbounded run. Excess is dropped with a notice — never silently.
  const room = MAX_UPLOAD_FILES - staged.value.length
  if (room <= 0) {
    notice.value = `В списке уже ${MAX_UPLOAD_FILES} файлов — это максимум. Нажмите «Импортировать» или уберите лишние файлы, чтобы добавить новые.`
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
      ? { id: nextId++, key: newKey(), file: f, status: 'queued' }
      : { id: nextId++, key: newKey(), file: f, status: 'error', error: v.error, invalid: true })
    added++
  }
  const notes: string[] = []
  if (dupes) notes.push(`${dupes} уже в списке — пропущено`)
  if (added < files.length - dupes) notes.push(`за раз можно не больше ${MAX_UPLOAD_FILES} файлов`)
  notice.value = notes.length ? `Добавлено ${added} из ${files.length}: ${notes.join('; ')}.` : ''
}
// Dropping rows invalidates the notice — once the list the notice talks about is gone, keeping it
// would show a stale message over an unrelated, freshly staged batch.
function remove(id: number): void {
  staged.value = staged.value.filter(s => s.id !== id)
  if (!staged.value.length) notice.value = ''
}
// Uploadable rows: queued, or a retryable error (a network failure) — but NOT a pre-validation
// failure (invalid), which can never succeed and must not be re-sent.
const toImport = computed(() => staged.value.filter(s => s.status === 'queued' || (s.status === 'error' && !s.invalid)))

const STATUS_LABEL: Record<Status, string> = {
  queued: 'В очереди',
  uploading: 'Отправляем…',
  sent: 'Обрабатывается…',
  error: 'Ошибка'
}
const STATUS_COLOR: Record<Status, 'air-secondary' | 'air-primary' | 'air-primary-alert'> = {
  queued: 'air-secondary',
  uploading: 'air-primary',
  sent: 'air-primary',
  error: 'air-primary-alert'
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** How often the wait loop re-checks job states. Local state only — cheap; small enough that
 *  «Отменить» answers promptly (the flag is read at the top of each pass). */
const WAIT_TICK_MS = 250

// The tab must stay open while a run is in flight: with no localStorage the run's identity lives in
// page memory only. The banner says it in words; this native prompt catches the reflexive Ctrl-W.
function beforeUnload(e: BeforeUnloadEvent): void {
  e.preventDefault()
  e.returnValue = '' // required by Chrome for the prompt to show
}
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('beforeunload', beforeUnload)
})

async function startImport(): Promise<void> {
  if (importing.value) return
  const queue = toImport.value
  if (!queue.length) return
  importing.value = true
  cancelled.value = false
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', beforeUnload)
  let sentTotal = 0
  let doneOk = 0
  let failed = 0
  // try/finally around the whole run: `importing` disables the picker + the file input on this component AND
  // (via update:busy) on the rest of /app. If anything below ever threw, the flag would stay `true` and
  // the page would look alive but ignore every click (#258). `upload()` swallows its own errors today,
  // so this is a backstop, not a fix for a known throw.
  try {
    // PHASE 1 — upload the batch. Sequential HTTP posts (the upload itself is seconds; the WAIT is the
    // long part), one shared target, a failed file marks its row and the batch MOVES ON (owner ask).
    const sent: StagedFile[] = []
    // ⚠ ЦЕЛЬ ЗАМОРОЖЕНА НА ПРОГОН — снимок берётся ЗДЕСЬ, а цикл читает только его. Шапка это
    // обещала («frozen for the duration of the run»), но цикл брал `target.value` на КАЖДОМ файле:
    // пока цель менял один пикер, дефект спал, а с рассылкой настроек менять её на середине стало
    // кому. Исход на экране невидим — половина накладных в одной воронке, половина в другой, и
    // вскрывается это только в CRM. Замок на пикере (`:disabled`) — ВТОРОЙ и независимый: он
    // защищает от руки, снимок — от кода.
    const runTarget = target.value
    for (const s of queue) {
      if (cancelled.value) break
      // A queued row can still be removed while the run is going — skip any row that left the list.
      if (!staged.value.includes(s)) continue
      s.status = 'uploading'
      s.error = undefined
      notice.value = `Отправляем «${s.file.name}»…`
      // The row's stable key is the desired jobId → a retry of THIS row reuses it and can't create a
      // duplicate CRM entity (server keys the job on it; crm-sync marker dedups).
      const outcome = await props.upload(s.file, runTarget, s.key)
      if (outcome.ok) {
        s.status = 'sent'
        sent.push(s)
        sentTotal++
        // HAND-OVER (owner ask, #349): the file now lives in the results list below — «в очереди»,
        // then «разбирается», then the outcome. Keeping the row here too showed the same document
        // twice in two different states, and the reader had to work out which one was current.
        // The row leaves at the moment of hand-over, not when the job finishes.
        staged.value = staged.value.filter(x => x !== s)
      } else {
        s.status = 'error'
        s.error = outcome.message || UPLOAD_GENERIC_ERROR
        failed++
        // Rate-limit refusal is about the operator, not the file: every next row would hit the same
        // wall. That one still stops the batch; any other failure just moves on (owner ask).
        if (outcome.stop) break
      }
    }

    // PHASE 2 — wait until every accepted job reaches a terminal state. The rows are already OUT of
    // this list (handed over in phase 1), so the wait is tracked on its own set of keys — reading it
    // off `staged` would end the wait instantly now.
    const awaiting = new Set(sent.map(s => s.key))
    let ticks = 0
    while (!cancelled.value) {
      for (const key of [...awaiting]) {
        const done = props.jobDone(key)
        if (!done) continue
        if (done === 'error') failed++
        else doneOk++
        awaiting.delete(key)
      }
      const waitingFor = awaiting.size
      if (!waitingFor) break
      // «не закрывайте страницу» тут НЕ повторяем — эта фраза живёт только в баннере, иначе тесты
      // удовлетворялись бы дублем, а читатель слышал бы её от скринридера на каждый тик. Текст
      // меняем только при смене числа: role=status зачитывается на каждое обновление.
      const line = props.listError
        ? `Связь с порталом потеряна — пробуем восстановить… (${props.listError})`
        : `Обрабатываем: осталось ${waitingFor} из ${sentTotal}. Результаты появляются ниже.`
      if (notice.value !== line) notice.value = line
      // The parent's poll self-stops after a streak of failures; the wait phase would then hang in
      // silence. While the run is active we own the retry: every ~5 s poke refreshNow(), which
      // resets the streak and re-arms the loop (or refreshes the error text if still down).
      ticks++
      if (props.listError && ticks % 20 === 0) void props.refreshNow()
      await sleep(WAIT_TICK_MS)
    }

    if (cancelled.value) {
      // Rows leave this list on hand-over now (#349), so «still in flight» is read off the wait set,
      // not off `staged` — the old check counted nothing and the honest warning went silent exactly
      // when it mattered: a cancel cannot recall a job the server already accepted.
      const inFlight = awaiting.size
      // Honesty over comfort: the server HAS the sent files and will finish them — a cancel cannot
      // recall a job already accepted. What it does stop: uploading the rest and holding the page.
      notice.value = inFlight
        ? `Импорт отменён. Уже отправленные (${inFlight} ${pluralRu(inFlight, ['файл', 'файла', 'файлов'])}) сервер дообработает — их результат появится ниже. Остальные остались в списке.`
        : 'Импорт отменён. Неотправленные файлы остались в списке.'
      // Sent rows are already gone from the list; a row caught mid-upload goes back to «в очереди».
      for (const s of staged.value) {
        if (s.status === 'uploading') s.status = 'queued'
      }
    } else {
      notice.value = failed
        ? `Готово: успешно ${doneOk}, с ошибкой ${failed}. Подробности — ниже, в журнале, и на строках выше.`
        : sentTotal === 1
          ? 'Готово: файл обработан. Результат — ниже, в журнале.'
          : `Готово: все ${sentTotal} ${pluralRu(sentTotal, ['файл', 'файла', 'файлов'])} обработаны. Результаты — ниже, в журнале.`
    }
  } catch {
    // `upload()` handles its own errors today, so reaching here means something unexpected broke.
    // Swallow it into a visible notice instead of letting it escape the click handler as an
    // unhandled rejection — the rows below are reset to a retryable state either way.
    notice.value = 'Импорт прервался. Проверьте связь и нажмите «Импортировать» ещё раз.'
  } finally {
    importing.value = false // never leave the page locked, whatever happened above
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', beforeUnload)
    // A row interrupted mid-flight would otherwise stay «uploading» forever: that state hides its
    // «убрать» button AND keeps it out of `toImport`, so the file could be neither retried nor
    // removed without reloading the page. Put such rows back into a retryable error state.
    for (const s of staged.value) {
      if (s.status === 'uploading') {
        s.status = 'error'
        s.error = 'Отправка прервалась — нажмите «Импортировать» ещё раз.'
      }
    }
  }
}

/** «Отменить»: stop uploading the rest and stop holding the page. Already-sent jobs finish on the
 *  server — see the run notice. */
/**
 * Маршрут, выбранный на вкладке, перестал существовать (#488): пикер уже увёл выбор в «Авто», наше
 * дело — СКАЗАТЬ об этом. Молчаливая замена запрещена: человек увидел бы в поле другое значение и
 * не понял, почему, а следующая пачка ушла бы не туда, куда он рассчитывал.
 */
function onTargetInvalid(reason: TargetInvalidReason): void {
  toast.add({ title: 'Цель импорта изменена', description: targetInvalidMessage(reason), color: 'warning' })
}

function cancelImport(): void {
  cancelled.value = true
  // The sent jobs keep running server-side and their results still land below — make sure the
  // parent's poll is alive to show them (it may have self-stopped while we were waiting).
  void props.refreshNow()
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
        importing ? 'opacity-60' : '',
        dragging ? 'border-(--ui-color-accent-main-primary) bg-(--ui-color-accent-main-primary)/5' : 'border-(--ui-color-base-5) hover:border-(--ui-color-accent-main-primary)'
      ]"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <span
        class="mb-1 flex size-11 items-center justify-center rounded-full"
        :class="importing
          ? 'bg-(--ui-color-base-5)/40 text-(--ui-color-base-4)'
          : 'bg-(--ui-color-accent-main-primary)/10 text-(--ui-color-accent-main-primary)'"
        aria-hidden="true"
      ><AttachIcon class="size-5" /></span>
      <!-- max-w-prose keeps the invitation on ~2 lines at the widths the app is shown at (in-portal
           iframe and the B24 mobile app) instead of one long line the eye has to scan. -->
      <span class="max-w-prose text-base font-medium text-(--ui-color-base-1)">
        Нажмите, чтобы выбрать файл или сделать фото. Можно просто перетащить файлы сюда
      </span>
      <span class="text-sm text-(--ui-color-base-3)">
        <!-- ⚠ Предел строк назван ЗДЕСЬ, до загрузки. Прайс дистрибьютора на десятки тысяч
             позиций — обычное дело, а не экзотика, и узнавать о пределе после разбора значило бы
             получить отказ на документ, который вообще не следовало отправлять. Число берётся из
             того же `MAX_ITEMS`, которым предохранитель и проверяет: рукописное разъехалось бы. -->
        {{ importing ? 'Заблокировано, пока идёт импорт' : `${FORMATS_HUMAN} · до 20 МБ · до ${maxItemsHuman} строк товаров · чтобы начать, нажмите «Импортировать» внизу` }}
      </span>
      <input
        ref="fileInput"
        type="file"
        multiple
        :accept="UPLOAD_ACCEPT"
        :disabled="importing"
        class="sr-only"
        @change="onInputChange"
      >
    </label>

    <!-- The run banner: the ONLY persistent home of «не закрывайте страницу». Rendered outside the
         staged card so it survives the moment the last row moves down to «Последние операции». -->
    <B24Alert
      v-if="importing"
      class="mt-3"
      color="air-primary"
      size="sm"
      title="Идёт импорт — не закрывайте страницу"
      description="Список результатов живёт только на этой странице: закроете или перезагрузите — он пропадёт, хотя сами документы сервер дообработает."
      role="status"
    />

    <!-- Staged list: file rows + status. The target is ONE for the whole batch (below the list).
         Kept mounted WHILE THE RUN IS ON even when the list has emptied (#349): rows now leave on
         hand-over, so the card would vanish mid-run and take «Отменить» with it — the employee would
         be locked out of the page with no way to stop waiting. -->
    <B24Card
      v-if="staged.length || importing"
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
            <span class="shrink-0 text-xs text-(--ui-color-base-4)">{{ formatBytes(s.file.size) }}</span>
            <div class="flex shrink-0 items-center gap-2">
              <B24Badge
                :label="STATUS_LABEL[s.status]"
                :color="STATUS_COLOR[s.status]"
                size="sm"
              />
              <B24Button
                v-if="s.status === 'queued' || (s.status === 'error' && !importing)"
                :icon="CrossMIcon"
                color="air-tertiary-no-accent"
                size="xs"
                :aria-label="`Убрать ${s.file.name}`"
                @click="() => remove(s.id)"
              />
            </div>
          </div>
          <p
            v-if="s.error"
            class="text-xs text-(--ui-color-accent-main-alert)"
          >
            {{ s.error }}
          </p>
        </li>
      </ul>
      <p
        v-if="notice"
        class="border-t border-(--ui-color-base-5) bg-(--ui-color-base-7) px-3 py-2 text-xs text-(--ui-color-base-3)"
        role="status"
      >
        {{ notice }}
      </p>
    </B24Card>

    <!-- ONE target for the whole batch (owner ask) + the action row. -->
    <!-- Actions stay while the run is on even after the last row was handed over (#349) — otherwise
         «Отменить» disappears mid-run and the locked page has no way out. -->
    <div
      v-if="staged.length || importing"
      class="mt-3 flex flex-wrap items-center gap-3"
    >
      <!-- ⚠ Заморозка цели на время пачки — НАСТОЯЩАЯ, а не `pointer-events-none` (#443): тот приём
           блокирует только мышь, а поля пикера остаются в порядке обхода по Tab и меняются с
           клавиатуры. Цена этой дыры была не косметической: цель одна на пачку, и смена её посреди
           прогона увела бы оставшиеся файлы в другое место — молча и вопреки тому, что человек
           видел, когда запускал. `opacity` осталась оформлением. -->
      <div
        class="flex min-w-0 flex-wrap items-center gap-2"
        :class="importing ? 'opacity-60' : ''"
      >
        <span class="text-xs text-(--ui-color-base-4)">Куда импортировать:</span>
        <TargetPicker
          v-model:target="target"
          :disabled="importing"
          @invalid="onTargetInvalid"
        />
      </div>
      <B24Button
        color="air-primary"
        :loading="importing"
        :disabled="importing || !toImport.length"
        :label="importing ? 'Импорт…' : `Импортировать${toImport.length ? ` (${toImport.length})` : ''}`"
        @click="startImport"
      />
      <B24Button
        v-if="importing"
        color="air-tertiary"
        :disabled="cancelled"
        :label="cancelled ? 'Останавливаем…' : 'Отменить'"
        @click="cancelImport"
      />
    </div>

    <!-- Notice when there is NO staged list to host it (the list renders its own footer line). -->
    <B24Alert
      v-if="notice && !staged.length && !importing"
      class="mt-3"
      :color="importing ? 'air-primary' : 'air-primary-success'"
      size="sm"
      :title="notice"
      role="status"
    />
  </div>
</template>
