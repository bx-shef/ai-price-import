import type { Announcement, AnnouncementDraft } from '~/utils/announcement'
import { announcementProblems, buildAnnouncement } from '~/utils/announcement'

// Решение консоли оператора по объявлению (#469) — чистое ядро с внедрёнными эффектами.
//
// ⚠ Вынесено из роута намеренно: отправка объявления — действие БЕЗ ОТКАТА (окно, которое уже
// открыли, не отзывается), и его условия обязаны быть под тестом, а не под внимательностью. Греп по
// исходнику здесь не годится — он ловит удаление строки и не ловит подмену значения.

export type AnnouncementOpAction = 'preview' | 'publish' | 'clear'

export interface AnnouncementOpEffects {
  publish: (a: Announcement) => Promise<boolean>
  clear: () => Promise<boolean>
  now: () => number
}

export interface AnnouncementOpResult {
  status: number
  body: Record<string, unknown>
}

/**
 * Выполнить действие оператора.
 *
 * ⚠ Публикация требует ЯВНОГО `confirm: true` — это второй шаг подтверждения, и он серверный.
 * Двух шагов только в интерфейсе мало: кнопка исчезает вместе с вкладкой, а роут остаётся, и
 * «раз в интерфейсе два клика, сервер можно упростить» — ровно тот случай, когда защита пропадает
 * вместе с разметкой. Предпросмотр (`preview`) подтверждения не требует и ничего не пишет.
 * ⚠ Негодный черновик отвергается ДО записи и с перечнем причин: «не получилось» без причины
 * заставляет угадывать, а объявление пишут редко и каждый раз заново.
 * ⚠ Неудачная запись — 503 и прямая формулировка: молчаливый успех означал бы, что оператор ждёт
 * реакции клиентов на рассылку, которой не было.
 */
export async function handleAnnouncementOp(
  action: unknown,
  draft: AnnouncementDraft,
  confirm: unknown,
  fx: AnnouncementOpEffects
): Promise<AnnouncementOpResult> {
  if (action === 'clear') {
    const ok = await fx.clear()
    return ok
      ? { status: 200, body: { ok: true, cleared: true } }
      : { status: 503, body: { error: 'объявление не снято: хранилище недоступно' } }
  }

  if (action !== 'preview' && action !== 'publish') {
    return { status: 400, body: { error: 'неизвестное действие' } }
  }

  const problems = announcementProblems(draft)
  if (problems.length) return { status: 400, body: { error: 'объявление не годится', problems } }

  const announcement = buildAnnouncement(draft, fx.now())
  if (action === 'preview') return { status: 200, body: { ok: true, preview: announcement } }

  if (confirm !== true) {
    return { status: 409, body: { error: 'нужно подтверждение: объявление нельзя отозвать у тех, кто его уже открыл' } }
  }
  const ok = await fx.publish(announcement)
  return ok
    ? { status: 200, body: { ok: true, announcement } }
    : { status: 503, body: { error: 'объявление НЕ отправлено: хранилище недоступно' } }
}
