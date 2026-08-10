<script setup lang="ts">
import { frameAuthMessage } from '~/utils/frameHeaders'
import { useB24 } from '~/composables/useB24'
import { computed, onMounted, ref } from 'vue'
import LikeIcon from '@bitrix24/b24icons-vue/outline/LikeIcon'
import DislikeIcon from '@bitrix24/b24icons-vue/outline/DislikeIcon'
import { useFeedback } from '~/composables/useFeedback'
import { MAX_FEEDBACK_FILE_BYTES } from '~/config/uploadFormats'
import { UPLOAD_ACCEPT, formatBytes } from '~/utils/importUpload'

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
// ФАЙЛ БЕРЁТ СЕРВЕР ИЗ ДЕЛА ТАЙМЛАЙНА (#461), страница его больше не везёт. Прежде байты слал сам
// браузер из памяти (#349), и это оставляло дыру: перезагрузил вкладку — и отзыв уходил без
// документа, то есть без того, ради чего отзыв на «документ не распознан» вообще нужен. Теперь у
// каждого импорта есть дело с вложенным документом, и сервер находит его по маркеру задания,
// сузив выборку до самого сотрудника. Отсюда же исчезли выбор файла вручную и предупреждение о
// размере: страница о файле больше ничего не знает и обещать за сервер не может.
const props = defineProps<{
  jobId?: string
  fileName?: string
  /**
   * У этой записи НЕТ дела в CRM, поэтому документ взять неоткуда — его выбирает человек с диска
   * (#506 п.3). Так бывает у импорта, упавшего на извлечении: до CRM он не дошёл, дела нет, а
   * документ нужен именно тогда — без битого файла воспроизвести нечего.
   * ⚠ Путь через дело остаётся ОСНОВНЫМ: проп ставится только там, где дела заведомо не будет.
   */
  pickFile?: boolean
}>()
const { enabled, ensureEnabled, submit } = useFeedback()

// Какую оценку подтверждаем в форме. `null` — форма ещё не открыта: отдельного флага «форма видна»
// нет намеренно, два состояния об одном и том же могли бы разойтись.
const pending = ref<'up' | 'down' | null>(null)
const open = computed(() => pending.value !== null)
const comment = ref('')
// Спрашиваем про файл после нажатия «Отправить»: `null` — вопрос ещё не задан.
const asking = ref(false)
const sending = ref(false)
const { inFrame } = useB24()
const sent = ref(false)
/** «Отзыв принят, но файл не приложен» — общий предел приёмника (#354). Молчание тут читалось бы
 *  как «документ ушёл». */
const notice = ref('')
const error = ref('')
/** Выбранный с диска документ — только когда `pickFile` (дела нет). */
const chosen = ref<File | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

function onPick(e: Event): void {
  const f = (e.target as HTMLInputElement)?.files?.[0] ?? null
  // ⚠ Размер проверяем СРАЗУ и молча не режем: узнать о превышении после отправки — значит потерять
  // и время, и сам отзыв. Число то же, что у загрузки документа (одно на клиент и сервер).
  if (f && f.size > MAX_FEEDBACK_FILE_BYTES) {
    error.value = `Файл больше ${formatBytes(MAX_FEEDBACK_FILE_BYTES)} — приложить не получится. Отправьте отзыв без файла и пришлите документ отдельно.`
    chosen.value = null
    return
  }
  error.value = ''
  chosen.value = f
}

/** Прочитать выбранный файл в base64 для тела запроса. */
async function readChosen(): Promise<{ name: string, contentBase64: string } | null> {
  const f = chosen.value
  if (!f) return null
  const buf = new Uint8Array(await f.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!)
  return { name: f.name, contentBase64: btoa(bin) }
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
    // ⚠ Байты едут ТОЛЬКО когда дела нет и человек сам выбрал файл. В обычном случае документ
    // читает сервер из вложения дела — страница о нём ничего не знает и обещать за сервер не может.
    const upload = withFile && props.pickFile ? await readChosen() : null
    const ctx = { jobId: props.jobId, fileName: props.fileName }
    // ⚠ Пятый аргумент передаётся ТОЛЬКО когда байты есть: в обычном случае вызов остаётся ровно
    // таким же, каким был, и путь «документ читает сервер из дела» не меняется ни на йоту.
    const res = upload
      ? await submit(kind, comment.value.trim() || undefined, ctx, withFile, upload)
      : await submit(kind, comment.value.trim() || undefined, ctx, withFile)
    if (res.ok) {
      sent.value = true
      notice.value = res.notice ?? ''
    } else {
      error.value = frameAuthMessage(inFrame(), 'Отзыв доступен')
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
          <p
            v-if="!pickFile"
            class="text-(--ui-color-base-4)"
          >
            Копия документа уйдёт разработчику вместе с отзывом — она нужна, чтобы воспроизвести разбор.
            Документ берётся из дела в CRM, куда приложение вложило его при импорте, — выбирать файл
            заново не нужно.
          </p>
          <!-- ⚠ Здесь дела НЕТ (#506 п.3): импорт упал на разборе и до CRM не дошёл, поэтому взять
               документ неоткуда — его выбирает человек. Говорим об этом прямо: молчаливое «выберите
               файл» после обещания «берётся из дела» читалось бы как поломка. -->
          <template v-else>
            <p class="text-(--ui-color-base-4)">
              Этот документ до CRM не дошёл, поэтому копии у нас нет — выберите файл, который
              загружали. Он уйдёт разработчику вместе с отзывом: без него воспроизвести не получится.
            </p>
            <input
              ref="fileInput"
              type="file"
              class="sr-only"
              :accept="UPLOAD_ACCEPT"
              @change="onPick"
            >
            <div class="mt-1 flex flex-wrap items-center gap-2">
              <B24Button
                size="xs"
                color="air-secondary-accent"
                :disabled="sending"
                :label="chosen ? 'Выбрать другой файл' : 'Выбрать файл'"
                @click="fileInput?.click()"
              />
              <span
                v-if="chosen"
                class="text-(--ui-color-base-3) break-all"
              >{{ chosen.name }} · {{ formatBytes(chosen.size) }}</span>
            </div>
          </template>
          <div class="mt-1 flex flex-wrap items-center gap-2">
            <!-- ⚠ Пока файл не выбран, кнопка не работает: иначе «Отправить с файлом» отправит БЕЗ
                 файла, и человек будет уверен, что документ ушёл. Подпись объясняет, чего ждём. -->
            <B24Button
              size="xs"
              color="air-primary"
              :loading="sending"
              :disabled="sending || (pickFile && !chosen)"
              :label="pickFile && !chosen ? 'Сначала выберите файл' : 'Отправить с файлом'"
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
