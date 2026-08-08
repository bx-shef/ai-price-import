import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders } from '~/utils/frameHeaders'

// In-portal feedback client (#182 channel «сотрудник»): submit 👍/👎 + a comment on the import
// result. The channel is server-gated (GITHUB_FEEDBACK_* env) — `enabled` is probed ONCE and shared
// by every widget (module-level ref) so N rows don't each hit /api/feedback. Inert outside a portal.

/** Import context attached to the feedback issue (all optional; rendered inert server-side). */
export interface FeedbackSubmitContext {
  jobId?: string
  fileName?: string
  entityType?: string
  entityId?: string | number
  entityUrl?: string
  appVersion?: string
}

const enabled = ref<boolean | null>(null) // null = not probed yet; shared across widgets
let probing: Promise<void> | null = null

export function useFeedback() {
  const { init, ensureAuth } = useB24()

  /** Probe whether the channel is on (once). Failure → treated as OFF (widget stays hidden). */
  async function ensureEnabled(): Promise<void> {
    if (enabled.value !== null) return
    if (!probing) {
      probing = (async () => {
        try {
          const r = await $fetch<{ enabled?: boolean }>('/api/feedback')
          enabled.value = !!r?.enabled
        } catch {
          enabled.value = false
        }
      })()
    }
    await probing
  }

  /**
   * Send a rating (+ optional comment + import context + file-attach consent). Throws on failure;
   * returns false outside a portal. Context (jobId/file) traces the issue back to a run — permitted
   * because the receiving repo is private (see feedback.ts). `attachFile` is the employee's explicit
   * consent (#192 п.3) to include the source document.
   *
   * ⚠ БАЙТЫ БОЛЬШЕ НЕ ЕДУТ ОТСЮДА (#461): по согласию их читает сервер из вложения дела таймлайна.
   * Прежде их слала страница из памяти, и перезагруженная вкладка молча лишала отзыв документа.
   */
  async function submit(
    kind: 'up' | 'down',
    comment?: string,
    context?: FeedbackSubmitContext,
    attachFile?: boolean
  ): Promise<{ ok: boolean, notice?: string }> {
    await init()
    const headers = buildFrameHeaders(await ensureAuth())
    if (!headers) return { ok: false } // outside a portal — no frame token
    const r = await $fetch<{ ok?: boolean, notice?: string }>('/api/feedback', {
      method: 'POST',
      headers,
      // Уходит только СОГЛАСИЕ; документ по нему найдёт и приложит сервер (#461).
      body: { kind, comment, context, attachFile: attachFile === true }
    })
    // `notice` — отзыв принят, но файл приложить не вышло (общий предел приёмника, #354). Молча
    // выбросить вложение нельзя: человек будет уверен, что документ ушёл.
    return { ok: true, ...(r?.notice ? { notice: r.notice } : {}) }
  }

  return { enabled, ensureEnabled, submit }
}
