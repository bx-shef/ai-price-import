import { PENDING_LEGAL_EDITIONS } from '../../app/config/legalNotice'
import { dispatchLegalNotices } from '../utils/legalNoticeDispatch'
import { liveLegalNoticeDeps } from '../queue/liveDeps'
import { buildLiveInfra } from '../queue/worker'
import { queueRuntimeConfig } from '../queue/runtime'
import { dbEnabled } from '../db/client'
import { resolveTelegramConfig, sendTelegramAlert } from '../utils/telegramAlert'
import { APP_NAME } from '../../app/config/appIdentity'

// Рассылка уведомления об изменении юридических документов в чаты порталов (#418, п. 9.3.3).
//
// ⚠ ОТДЕЛЬНЫЙ плагин, а не ветка внутри `queue.ts`, и это не вкусовщина. Тот выходит первой же
// строкой при `!queueEnabled()`, то есть без Redis. Рассылке Redis не нужен вовсе — только Postgres
// и REST к порталу, — и на развёртывании без Redis (он в проекте предусмотрен) уведомление по
// каналу «чат» не ушло бы НИ РАЗУ, молча. П. 9.3.3 требует оба способа одновременно, так что
// работал бы ровно один, и узнали бы об этом в споре.
//
// Раз в сутки и только на крон-экземпляре: N реплик воркера слали бы N копий в чужой чат.
export default defineNitroPlugin((nitroApp) => {
  if (import.meta.prerender) return
  if (!queueRuntimeConfig().cron) return
  if (!dbEnabled()) {
    console.warn('[legal-notice] рассылка выключена — нет базы; уведомление уйдёт только баннером')
    return
  }

  const infra = buildLiveInfra()
  const alert = resolveTelegramConfig(process.env)
  /** Сколько проходов подряд по редакции закончились неудачей. Повод сказать вслух — второй. */
  const failStreak = new Map<string, number>()

  const run = async () => {
    try {
      const today = new Date().toISOString().slice(0, 10)
      const res = await dispatchLegalNotices({ today, editions: PENDING_LEGAL_EDITIONS, ...liveLegalNoticeDeps(infra) })
      // Строка на КАЖДОМ проходе, включая пустой: молчание неотличимо от «плагин не поднялся», а это
      // разные вещи, и вторая означает нарушение срока.
      console.info(`[legal-notice] проход: объявлений ${PENDING_LEGAL_EDITIONS.length}, отправлено ${res.sent}, не доставлено ${res.failed}, доставлять некуда ${res.undeliverable}`)

      // ⚠ Тревога — как в чистке отзывов (#417): это обязанность по договору со сроком, и молчаливый
      // отказ означает пропущенный срок уведомления. Лог и `/queues` требуют, чтобы кто-то уже
      // смотрел; телеграм стучится сам.
      //
      // ⚠ Отвергнутое объявление — тревога СРАЗУ: рассылка по нему не пойдёт вообще, ждать второго
      // прохода незачем.
      if (res.rejected.length && alert) {
        await sendTelegramAlert(alert, `⚠️ ${APP_NAME}: уведомление об изменении документов НЕ разослано — ${res.rejected.join(' | ')}`, fetch)
      }
      // ⚠ А недоставку объявляем со второго прохода подряд: разовый отказ портала — норма
      // мультитенанта, и сообщение на каждый такой превратило бы канал в шум.
      for (const edition of PENDING_LEGAL_EDITIONS) {
        const key = `${edition.slug}@${edition.date}`
        if (res.failed > 0) {
          const streak = (failStreak.get(key) ?? 0) + 1
          failStreak.set(key, streak)
          if (streak === 2 && alert) {
            await sendTelegramAlert(alert, `⚠️ ${APP_NAME}: уведомление об изменении документов не доходит до ${res.failed} порталов второй проход подряд (${key}). Срок уведомления идёт.`, fetch)
          }
        } else {
          failStreak.delete(key)
        }
      }
    } catch (err) {
      // Сюда доходит только сбой первой выборки — отказ конкретного портала изолирован внутри.
      console.error('[legal-notice] проход не удался:', (err as Error)?.message)
    }
  }

  const timer = setInterval(run, 24 * 3_600_000)
  void run()

  nitroApp.hooks.hook('close', () => {
    clearInterval(timer)
  })
})
