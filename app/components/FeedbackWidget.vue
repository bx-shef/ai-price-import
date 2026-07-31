<script setup lang="ts">
import { onMounted, ref } from 'vue'
import LikeIcon from '@bitrix24/b24icons-vue/outline/LikeIcon'
import DislikeIcon from '@bitrix24/b24icons-vue/outline/DislikeIcon'
import { useFeedback } from '~/composables/useFeedback'
import { importFeedbackKind, markImportFeedback } from '~/utils/importHistory'

// Compact «нравится / не нравится» widget under an import result row. Renders nothing unless the
// channel is enabled on the server (probed via useFeedback). ОБЕ оценки ведут себя ОДИНАКОВО (#299):
// нажатие открывает одну и ту же форму — комментарий + согласие приложить файл, — и только потом
// отправка. Раньше «нравится» отправлялось мгновенно и прикладывало файл БЕЗ спроса; согласие на
// передачу документа не может зависеть от того, какую кнопку нажали. Inert outside a portal (submit no-ops). Ported UX from #218.
// Optional jobId/fileName trace the issue back to the run (rendered inert server-side; the receiving
// repo is private, so client context is permitted). DUPLICATE SUPPRESSION is client-side: the
// employee's localStorage remembers which jobs they already rated (importHistory, keyed by jobId), so
// the widget won't re-ask after a reload — no server-side search-before-create.
const props = defineProps<{ jobId?: string, fileName?: string }>()
const { enabled, ensureEnabled, submit } = useFeedback()

const open = ref(false) // comment box shown
const pending = ref<'up' | 'down' | null>(null) // какую оценку подтверждаем в форме
const comment = ref('')
const attachFile = ref(false) // consent to attach the source-file link (#192 п.3)
const sending = ref(false)
const sent = ref(false)
const error = ref('')

onMounted(() => {
  ensureEnabled()
  // Already rated this job in this browser? Show the thanks state instead of re-offering (client-only).
  if (typeof window !== 'undefined' && props.jobId && importFeedbackKind(window.localStorage, props.jobId)) {
    sent.value = true
  }
})

/** Нажатие на оценку: всегда сначала форма (комментарий + согласие на файл), потом отправка. */
function pick(kind: 'up' | 'down'): void {
  pending.value = kind
  open.value = true
  error.value = ''
}

async function send(): Promise<void> {
  const kind = pending.value
  if (!kind) return
  sending.value = true
  error.value = ''
  try {
    // submit() returns false (without throwing) outside a portal frame — do NOT claim success.
    // Файл прикладываем ТОЛЬКО по явной галочке — одинаково для обеих оценок (#299).
    const ok = await submit(kind, comment.value.trim() || undefined, {
      jobId: props.jobId,
      fileName: props.fileName
    }, attachFile.value)
    if (ok) {
      sent.value = true
      // Remember it locally so a reload doesn't re-ask for this job (the client is the dedup owner).
      if (typeof window !== 'undefined' && props.jobId) markImportFeedback(window.localStorage, props.jobId, kind)
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
          aria-label="Хорошо"
          @click="pick('up')"
        />
        <B24Button
          :icon="DislikeIcon"
          size="xs"
          :color="pending === 'down' ? 'air-primary-alert' : 'air-tertiary-no-accent'"
          :disabled="sending"
          aria-label="Плохо"
          @click="pick('down')"
        />
      </div>
      <!-- Ошибка отправки до открытия формы (например, вне портала). -->
      <p
        v-if="error && !open"
        class="mt-1 text-(--ui-color-accent-main-alert)"
        role="alert"
      >
        {{ error }}
      </p>
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
        <B24Checkbox
          v-model="attachFile"
          size="xs"
          label="Приложить исходный файл"
          description="Ссылка на файл в задаче (если он был сохранён на Диск портала)"
        />
        <div class="flex items-center gap-2">
          <B24Button
            size="xs"
            color="air-primary"
            :loading="sending"
            :disabled="sending"
            :label="sending ? 'Отправка…' : 'Отправить'"
            @click="send"
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
