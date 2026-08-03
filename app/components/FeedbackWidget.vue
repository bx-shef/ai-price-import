<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import LikeIcon from '@bitrix24/b24icons-vue/outline/LikeIcon'
import DislikeIcon from '@bitrix24/b24icons-vue/outline/DislikeIcon'
import { useFeedback } from '~/composables/useFeedback'
import { UPLOAD_ACCEPT } from '~/utils/importUpload'
// Кап вложения — ОДНО число на клиент и сервер (#351 ревью): два независимых разъехались бы молча,
// потому что превышение не ломает отправку — вложение просто исчезает, а отзыв уходит «успешно».
// Импорт принимает 20 МБ, поэтому скан вполне может кап превысить, и сказать об этом надо заранее.
import { MAX_FEEDBACK_FILE_BYTES } from '~/config/uploadFormats'

// Compact «нравится / не нравится» widget under an import result row. Renders nothing unless the
// channel is enabled on the server (probed via useFeedback). ОБЕ оценки ведут себя ОДИНАКОВО (#299):
// нажатие открывает одну и ту же форму, и дальше путь один и тот же. Раньше «нравится» отправлялось
// мгновенно и прикладывало файл БЕЗ спроса; согласие на передачу документа не может зависеть от того,
// какую кнопку нажали.
//
// Про файл спрашиваем В МОМЕНТ ОТПРАВКИ, а не галочкой в форме. Галочка стояла рядом с комментарием,
// когда сотрудник ещё не решил, отправляет ли он вообще, — и «Приложить исходный файл» читалось как
// часть оформления отзыва, а не как отдельное решение отдать документ наружу. Теперь «Отправить»
// открывает ровно один вопрос с двумя равноправными ответами: с файлом или без.
// Inert outside a portal (submit no-ops). Ported UX from #218.
// Optional jobId/fileName trace the issue back to the run (rendered inert server-side; the receiving
// repo is private, so client context is permitted). DUPLICATE SUPPRESSION lives in this component's
// state only: the job list itself is page-memory now (localStorage dropped — owner rework), so a rated
// row simply shows «Спасибо» until the page dies together with the list. No server-side
// search-before-create either.
//
// ФАЙЛ БЕРЁТСЯ ИЗ ПАМЯТИ СТРАНИЦЫ (#349): сервер удаляет загруженные байты сразу после извлечения
// текста, поэтому «дай мне файл этого задания» ему больше не адресуешь. Страница всё ещё держит
// выбранный сотрудником File — его и отправляем вместе с оценкой. Если файла в памяти нет
// (перезагрузили вкладку, открыли в другой), честно предлагаем выбрать его вручную, а не молча
// отправляем отзыв без файла: у «документ не распознан» файл — это вся суть отзыва.
const props = defineProps<{ jobId?: string, fileName?: string, file?: File | null }>()
const { enabled, ensureEnabled, submit } = useFeedback()

// Какую оценку подтверждаем в форме. `null` — форма ещё не открыта: отдельного флага «форма видна»
// нет намеренно, два состояния об одном и том же могли бы разойтись.
const pending = ref<'up' | 'down' | null>(null)
const open = computed(() => pending.value !== null)
const comment = ref('')
// Спрашиваем про файл после нажатия «Отправить»: `null` — вопрос ещё не задан.
const asking = ref(false)
const sending = ref(false)
const sent = ref(false)
/** «Отзыв принят, но файл не приложен» — общий предел приёмника (#354). Молчание тут читалось бы
 *  как «документ ушёл». */
const notice = ref('')
const error = ref('')
/** Файл, выбранный вручную, когда страница своей копии уже не держит. */
const manualFile = ref<File | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
/** Файл-кандидат: копия страницы либо выбранная вручную. Может оказаться слишком большим. */
const candidateFile = computed<File | null>(() => manualFile.value ?? props.file ?? null)
/** Слишком большой файл — не «нет файла»: об этом надо сказать, а не молча отправить без него. */
const tooBig = computed(() => !!candidateFile.value && candidateFile.value.size > MAX_FEEDBACK_FILE_BYTES)
/** Что реально уйдёт с отзывом. */
const fileToSend = computed<File | null>(() => (tooBig.value ? null : candidateFile.value))

/** Прочитать файл в base64 для отправки. Возвращает null, если чтение не удалось — отзыв уйдёт
 *  без файла, но уйдёт: терять оценку из-за сбоя чтения хуже, чем потерять вложение. */
async function readAsBase64(file: File): Promise<{ name: string, base64: string } | null> {
  try {
    const buf = await file.arrayBuffer()
    let binary = ''
    const bytes = new Uint8Array(buf)
    const CHUNK = 0x8000 // посимвольный String.fromCharCode переполнил бы стек на мегабайтах
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return { name: file.name, base64: btoa(binary) }
  } catch {
    return null
  }
}

function pickManualFile(e: Event): void {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0] ?? null
  if (f) manualFile.value = f
  input.value = ''
}

onMounted(() => {
  ensureEnabled()
})

/** Нажатие на оценку: всегда сначала форма (комментарий + согласие на файл), потом отправка. */
function pick(kind: 'up' | 'down'): void {
  pending.value = kind
  error.value = '' // прошлая неудача не должна висеть над новой попыткой
}

/** «Отправить» ничего не отправляет — только задаёт единственный вопрос про файл. */
function askAboutFile(): void {
  asking.value = true
  error.value = ''
}

async function send(withFile: boolean): Promise<void> {
  const kind = pending.value
  if (!kind) return
  asking.value = false
  sending.value = true
  error.value = ''
  try {
    // submit() returns false (without throwing) outside a portal frame — do NOT claim success.
    // Файл уходит ТОЛЬКО по явному ответу на вопрос — одинаково для обеих оценок (#299).
    const attachment = withFile && fileToSend.value ? await readAsBase64(fileToSend.value) : null
    const res = await submit(kind, comment.value.trim() || undefined, {
      jobId: props.jobId,
      fileName: props.fileName
    }, withFile, attachment)
    if (res.ok) {
      sent.value = true
      notice.value = res.notice ?? ''
    } else {
      error.value = 'Отзыв доступен только внутри портала Bitrix24'
    }
  } catch {
    error.value = 'Не удалось отправить отзыв'
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div
    v-if="enabled"
    class="mt-1 text-xs"
  >
    <p
      v-if="sent"
      class="text-(--ui-color-accent-main-success)"
      role="status"
    >
      Спасибо за отзыв!
      <span
        v-if="notice"
        class="block text-(--ui-color-accent-main-warning)"
      >{{ notice }}</span>
    </p>
    <template v-else>
      <div class="flex items-center gap-2 text-(--ui-color-base-4)">
        <span>Всё верно?</span>
        <!-- Иконки b24icons вместо эмодзи (#299): в интерфейсе портала эмодзи выглядят чужеродно и
             рисуются по-разному на разных системах. Выбранная оценка подсвечена — форма одна на обе,
             и без подсветки было бы не видно, что именно отправляешь. -->
        <B24Button
          :icon="LikeIcon"
          size="xs"
          :color="pending === 'up' ? 'air-primary-success' : 'air-tertiary-no-accent'"
          :disabled="sending"
          :aria-pressed="pending === 'up'"
          aria-label="Хорошо"
          @click="pick('up')"
        />
        <B24Button
          :icon="DislikeIcon"
          size="xs"
          :color="pending === 'down' ? 'air-primary-alert' : 'air-tertiary-no-accent'"
          :disabled="sending"
          :aria-pressed="pending === 'down'"
          aria-label="Плохо"
          @click="pick('down')"
        />
      </div>
      <div
        v-if="open"
        class="mt-1 flex flex-col gap-1"
      >
        <textarea
          v-model="comment"
          rows="2"
          maxlength="5000"
          :aria-label="pending === 'up' ? 'Что понравилось' : 'Что пошло не так'"
          :placeholder="pending === 'up' ? 'Что получилось хорошо? (необязательно)' : 'Что пошло не так? (необязательно)'"
          class="w-full rounded border border-(--ui-color-base-5) p-1.5 text-xs"
        />
        <!-- Вопрос про файл — ОТДЕЛЬНЫЙ шаг после «Отправить», а не галочка в форме: отдать документ
             наружу это решение само по себе, и принимать его надо тогда, когда уже решил отправлять.
             Два равноправных ответа, ни один не «по умолчанию»: молча приложить чужой счёт нельзя,
             но и прятать полезный вариант в неприметную ссылку — тоже. -->
        <div
          v-if="asking"
          class="flex flex-col gap-1 rounded border border-(--ui-color-base-5) p-2"
          role="group"
          aria-label="Приложить исходный файл?"
        >
          <p class="text-(--ui-color-base-3)">
            Приложить исходный файл?
          </p>
          <p class="text-(--ui-color-base-4)">
            Копия документа уйдёт разработчику вместе с отзывом — она нужна, чтобы воспроизвести разбор.
            <template v-if="fileToSend">
              Отправится «{{ fileToSend.name }}» — файл берётся из этой страницы, на сервере он не хранится.
            </template>
            <template v-else-if="tooBig">
              Файл «{{ candidateFile?.name }}» слишком большой, чтобы приложить его к отзыву
              (больше {{ Math.round(MAX_FEEDBACK_FILE_BYTES / 1024 / 1024) }} МБ). Отправьте отзыв без файла —
              напишите в комментарии, что было в документе, и мы попросим его отдельно.
            </template>
            <template v-else>
              Эта страница копию документа уже не держит (перезагрузили вкладку или открыли в другой),
              а на сервере файл не хранится — выберите его вручную или отправьте отзыв без файла.
            </template>
          </p>
          <div
            v-if="!fileToSend"
            class="mt-1"
          >
            <B24Button
              size="xs"
              color="air-tertiary"
              :disabled="sending"
              label="Выбрать файл"
              @click="fileInput?.click()"
            />
            <input
              ref="fileInput"
              type="file"
              class="sr-only"
              :accept="UPLOAD_ACCEPT"
              @change="pickManualFile"
            >
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-2">
            <B24Button
              size="xs"
              color="air-primary"
              :loading="sending"
              :disabled="sending || !fileToSend"
              label="Отправить с файлом"
              @click="send(true)"
            />
            <B24Button
              size="xs"
              color="air-tertiary"
              :disabled="sending"
              label="Отправить без файла"
              @click="send(false)"
            />
          </div>
        </div>
        <div class="flex items-center gap-2">
          <B24Button
            v-if="!asking"
            size="xs"
            color="air-primary"
            :loading="sending"
            :disabled="sending"
            :label="sending ? 'Отправка…' : 'Отправить'"
            @click="askAboutFile"
          />
          <span
            v-if="error"
            class="text-(--ui-color-accent-main-alert)"
            role="alert"
          >{{ error }}</span>
        </div>
      </div>
    </template>
  </div>
</template>
