<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useFeedback } from '~/composables/useFeedback'
import { importFeedbackKind, markImportFeedback } from '~/utils/importHistory'

// Compact 👍/👎 feedback widget under an import result row. Renders nothing unless the channel is
// enabled on the server (probed via useFeedback). 👍 sends immediately; 👎 first opens a comment
// box («что пошло не так»), then sends. Inert outside a portal (submit no-ops). Ported UX from #218.
// Optional jobId/fileName trace the issue back to the run (rendered inert server-side; the receiving
// repo is private, so client context is permitted). DUPLICATE SUPPRESSION is client-side: the
// employee's localStorage remembers which jobs they already rated (importHistory, keyed by jobId), so
// the widget won't re-ask after a reload — no server-side search-before-create.
const props = defineProps<{ jobId?: string, fileName?: string }>()
const { enabled, ensureEnabled, submit } = useFeedback()

const open = ref(false) // comment box shown
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

async function rate(kind: 'up' | 'down'): Promise<void> {
  // 👎 → ask what went wrong before sending (a comment makes negative feedback actionable). The
  // file-attach consent lives in this box too — 👍 stays an instant, no-friction positive signal.
  if (kind === 'down' && !open.value) {
    open.value = true
    return
  }
  sending.value = true
  error.value = ''
  try {
    // submit() returns false (without throwing) outside a portal frame — do NOT claim success.
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
        <span>Результат помог?</span>
        <button
          type="button"
          class="rounded px-1.5 py-0.5 hover:bg-(--ui-color-base-5) disabled:opacity-50"
          :disabled="sending"
          aria-label="Хорошо"
          @click="rate('up')"
        >
          👍
        </button>
        <button
          type="button"
          class="rounded px-1.5 py-0.5 hover:bg-(--ui-color-base-5) disabled:opacity-50"
          :disabled="sending"
          aria-label="Плохо"
          @click="rate('down')"
        >
          👎
        </button>
      </div>
      <!-- Ошибка отправки (в т.ч. для 👍-пути, где нет поля комментария). -->
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
          aria-label="Что пошло не так"
          placeholder="Что пошло не так? (необязательно)"
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
            @click="rate('down')"
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
