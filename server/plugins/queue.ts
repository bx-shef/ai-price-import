import type { Worker } from 'bullmq'
import { getQueue, queueEnabled, connectionOptions } from '../queue/connection'
import type { QueueName } from '../queue/topology'
import { evaluateQueueHealth } from '../utils/queueAlert'
import { MAX_FAILED_SCAN, readQueueHealth } from '../utils/queueHealthRead'
import { recordQueueHealth } from '../utils/queueAlertState'
import { alertMessage, emptyDeliveryState, episodeKey, markAnnounced, markRecovered, planAlertDelivery, recoveryMessage, type DeliveryState } from '../utils/queueAlertDeliver'
import { resolveTelegramConfig, sendTelegramAlert } from '../utils/telegramAlert'
import { buildLiveInfra, startEventWorker, startThroughputWorkers } from '../queue/worker'
import { liveKeepAliveDeps } from '../queue/liveDeps'
import { queueRuntimeConfig } from '../queue/runtime'
import { keepAliveIntervalMs, runTokenKeepAlive } from '../utils/tokenKeepAlive'
import { PORTAL_NOTICE_TTL_SEC, createPortalFailureRunner } from '../utils/portalFailureRun'
import { windowCounterStore } from '../utils/windowCounterRedis'

/** How often the queue health check reads counts. Also the window each alert speaks about. */
const QUEUE_HEALTH_INTERVAL_MS = 5 * 60 * 1000

// Nitro startup plugin: start the BullMQ workers in this instance, gated by the queue
// role (QUEUE_WORKERS / QUEUE_CRON — see runtime.ts). No-op without Redis (SSG/dev).
//
// One image, three roles (scale-out; ported from client-bank):
//   - single container (default): throughput workers + event worker here;
//   - HTTP/primary (QUEUE_WORKERS=0): serves the API + runs the SINGLE event worker;
//   - worker (QUEUE_CRON=0, RUN_MIGRATION=0), scaled to N replicas: drain extract/agent/
//     crm-sync only. Redis hands each job to exactly one replica.
// The b24-events worker rides on the cron/primary instance ONLY (install/uninstall must
// stay single-instance/ordered — the tombstone guard is TOCTOU-free only under one consumer).
export default defineNitroPlugin((nitroApp) => {
  if (import.meta.prerender) return
  if (!queueEnabled()) return

  const role = queueRuntimeConfig()
  const infra = (role.workers || role.cron) ? buildLiveInfra() : null
  const workers: Worker[] = []
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined
  let healthTimer: ReturnType<typeof setInterval> | undefined

  if (role.workers && infra) {
    workers.push(...startThroughputWorkers(infra))
    console.info('[queue] throughput workers started (extract/agent/crm-sync)')
  } else if (!role.workers) {
    // Loud: this instance won't drain the pipeline. A worker container MUST be running,
    // else uploads pile up silently (Redis up ⇒ enqueue succeeds ⇒ no sync fallback).
    console.warn('[queue] QUEUE_WORKERS=0 — this instance does NOT process extract/agent/crm-sync; a worker container MUST be running or those queues never drain')
  }

  // The SINGLE b24-events worker runs on the cron/primary instance (QUEUE_CRON=1), so
  // install/uninstall stay ordered even when the throughput `worker` service is scaled.
  if (role.cron && infra) {
    const events = startEventWorker(infra)
    if (events) {
      workers.push(events)
      console.info('[queue] b24-events worker started (single primary instance)')
    }

    // Proactive OAuth keep-alive (#175): an installed-but-idle portal makes no REST calls,
    // so the lazy refresh never fires and its refresh_token dies on day 180. Once a day,
    // refresh ONLY portals within ~3d of expiry. Needs the app creds; without them skip loud.
    const hasOAuthCreds = !!(process.env.B24_CLIENT_ID?.trim() && process.env.B24_CLIENT_SECRET?.trim())
    if (hasOAuthCreds) {
      const keepAliveDeps = liveKeepAliveDeps(infra)
      const keepAliveMs = keepAliveIntervalMs(Number(process.env.TOKEN_KEEPALIVE_HOURS || 24))
      const runKeepAlive = async () => {
        try {
          await runTokenKeepAlive(keepAliveDeps)
        } catch (err) {
          // Only a failure of the initial SELECT reaches here (per-portal failures are
          // isolated inside runTokenKeepAlive). Never let it crash the cron instance.
          console.error('[queue] token keep-alive run failed:', (err as Error)?.message)
        }
      }
      keepAliveTimer = setInterval(runKeepAlive, keepAliveMs)
      void runKeepAlive() // once at boot (cheap: a range scan + refresh of only near-expiry portals)
      console.info('[queue] token keep-alive scheduled (every %d h, #175)', keepAliveMs / 3_600_000)
    } else {
      console.warn('[queue] token keep-alive disabled — B24_CLIENT_ID/SECRET unset (idle portals may lose auth on day 180)')
    }

    // Queue health check (BACKLOG.md §1). /queues only ever showed a snapshot, which cannot tell
    // «навалило работы» from «встало»: both look like a big number. What tells them apart is how
    // long the OLDEST unfinished job has been sitting — see queueAlert.ts for the two wrong designs
    // that came before. Cron instance only: one voice, not one per worker replica.
    let healthRunning = false
    // What has already been said. In memory on purpose: it lives in the same process as the check,
    // and after a restart re-announcing an ongoing outage once is the RIGHT behaviour anyway — a
    // backend that keeps restarting is itself worth knowing about.
    let delivery: DeliveryState = emptyDeliveryState()
    // Resolved once: the channel is env-driven, and an unset one is a normal deployment (dev, a
    // build with no portal). Null → alerts stay in the log and on /queues, exactly as before.
    const telegram = resolveTelegramConfig(process.env)
    const queuesUrl = (() => {
      const base = String(process.env.NUXT_PUBLIC_SITE_URL ?? '').trim().replace(/\/+$/, '')
      return /^https:\/\//i.test(base) ? `${base}/queues` : null
    })()
    console.info(telegram
      ? '[queue] alert channel: telegram'
      : '[queue] alert channel OFF — alerts go to the log and /queues only (set TELEGRAM_ALERT_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID)')

    // `true` only when the message actually reached the channel.
    const push = async (text: string): Promise<boolean> => {
      if (!telegram) return false
      try {
        const r = await sendTelegramAlert(telegram, text, fetch)
        // Status only — the URL carries the bot token, so nothing else from the call is loggable.
        if (!r.ok) console.error(`[queue-alert] telegram send failed: status=${r.status}`)
        return r.ok
      } catch {
        return false // alerting must never take the cron instance down
      }
    }

    // Carries this tick's plan out of the guarded section to the sending step below.
    let pending: ReturnType<typeof planAlertDelivery> | null = null

    const runHealthCheck = async () => {
      // Ticks must not overlap: a slow Redis read would otherwise stack them up.
      // ⚠ Пропуск ЛОГИРУЕТСЯ: молчаливое отбрасывание тиков и было половиной живого дефекта —
      // проверка висела 15 минут, а наружу это выглядело как «проверок просто не было».
      if (healthRunning) {
        console.warn('[queue] health check skipped — previous one still running')
        return
      }
      healthRunning = true
      try {
        const alerts = evaluateQueueHealth(await readQueueHealth({
          pending: async (name: QueueName) => {
            const q = getQueue(name)
            return q ? await q.getJobs(['waiting', 'active', 'delayed']) : []
          },
          failed: async (name: QueueName) => {
            const q = getQueue(name)
            return q ? await q.getFailed(0, MAX_FAILED_SCAN - 1) : []
          }
        }, Date.now()), Date.now())
        recordQueueHealth(alerts, Date.now())
        for (const a of alerts) console.warn(`[queue-alert] ${a.text}`)
        // ONE message per episode, not per check: a real outage outlives the 5-minute interval, and
        // a channel that repeats itself twelve times an hour stops being read — which defeats the
        // one occasion it exists for. Recovery is announced too, so «починилось» is distinguishable
        // from «мы перестали писать».
        const plan = planAlertDelivery(alerts, delivery, Date.now())
        delivery = plan.state
        pending = plan
      } catch (err) {
        // The reader isolates per-queue failures, so only a bug reaches here. Never record a
        // verdict we did not actually reach — a stale «всё хорошо» is worse than an old timestamp.
        console.error('[queue] health check failed:', (err as Error)?.message)
      } finally {
        healthRunning = false
      }

      // Sending happens AFTER the flag is released and outside the guarded section. A slow Telegram
      // must not stop the health check itself: an outgoing HTTP call hanging is correlated with the
      // very outage being reported, and a channel that silences its own monitor during an incident
      // is worse than no channel.
      if (!pending) return
      const { opened, recovered } = pending
      pending = null
      for (const a of opened) {
        // Marked as told only when it actually went out — otherwise one 429 would bury the alert
        // forever, since the episode is «ongoing» from the next check onwards.
        if (await push(alertMessage(a, queuesUrl))) delivery = markAnnounced(delivery, episodeKey(a), Date.now())
      }
      // Как и у тревоги: ключ выбывает из ожидания ТОЛЬКО по факту доставки. Иначе один отказ
      // Телеграма терял бы «✅» навсегда, и оператор остался бы с «сломалось» без закрытия.
      for (const key of recovered) {
        if (await push(recoveryMessage(key))) delivery = markRecovered(delivery, key)
      }

      // Порталы считаем ПОСЛЕ тревог и вне guarded-секции — по той же причине, что и отправку:
      // медленный Телеграм не должен задерживать саму проверку здоровья.
      if (runPortalWatch) {
        try {
          const r = await runPortalWatch()
          if (r.sent) console.warn(`[portal-fail] сообщено о порталах: ${r.announced.length}`)
        } catch (err) {
          console.error('[portal-fail] сбой наблюдения:', (err as Error)?.message)
        }
      }
    }
    // Наблюдение за порталами, у которых падают ВСЕ импорты (#498). Идёт тем же тиком, но это
    // ОТДЕЛЬНЫЙ механизм и ОТДЕЛЬНЫЙ канал: тревога значит «сервис сломан, разбуди меня», а здесь
    // сервис исправен — у клиента отозвано право или протухла авторизация. Смешать их значит
    // приучить читать канал вполглаза, и тогда он не сработает в тот раз, ради которого заведён.
    //
    // ⚠ Канал — СВОДКА (`TELEGRAM_DIGEST_*`), тот же, что у еженедельной сводки по отзывам: оба
    // сообщения про «накопилось», а не про «горит».
    const portalTelegram = resolveTelegramConfig(process.env, {
      token: 'TELEGRAM_DIGEST_BOT_TOKEN',
      chatId: 'TELEGRAM_DIGEST_CHAT_ID'
    })
    const noticeCounter = windowCounterStore(connectionOptions())
    if (portalTelegram && !noticeCounter) {
      // ⚠ Без Redis отсечка «один портал в сутки» держится только памятью процесса, а её тут нет
      // вовсе — значит сообщение придёт на каждом перезапуске. Говорим вслух: молчаливая
      // деградация читалась бы как исправная работа.
      console.warn('[portal-fail] нет Redis: отсечки «один портал в сутки» нет — сообщение придёт после каждого перезапуска')
    }
    const runPortalWatch = portalTelegram
      ? createPortalFailureRunner({
          listFailed: async () => {
            const q = getQueue('crm-sync')
            if (!q) return null
            try {
              return await q.getFailed(0, MAX_FAILED_SCAN - 1)
            } catch {
            // Нечитаемая очередь — НЕ «отказов нет»: см. разбор в `portalFailureRun`.
              return null
            }
          },
          send: async (text) => {
            try {
              const r = await sendTelegramAlert(portalTelegram, text, fetch)
              if (!r.ok) console.warn(`[portal-fail] сообщение не доставлено: status=${r.status}`)
              return r.ok
            } catch {
              return false // наблюдение не имеет права ронять cron-инстанс
            }
          },
          claimNotice: key => noticeCounter ? noticeCounter.incrWithTtl(key, PORTAL_NOTICE_TTL_SEC).catch(() => null) : Promise.resolve(null),
          ...(queuesUrl ? { queuesUrl } : {}),
          now: () => Date.now(),
          log: m => console.warn(`[portal-fail] ${m}`)
        })
      : null
    if (!portalTelegram) {
      console.info('[portal-fail] канал сводки не настроен — о падающих порталах сообщать некуда (TELEGRAM_DIGEST_BOT_TOKEN + TELEGRAM_DIGEST_CHAT_ID)')
    }

    healthTimer = setInterval(() => void runHealthCheck(), QUEUE_HEALTH_INTERVAL_MS)
    void runHealthCheck()
    console.info('[queue] health check scheduled (every %d min)', QUEUE_HEALTH_INTERVAL_MS / 60_000)
  } else if (!role.cron) {
    console.info('[queue] QUEUE_CRON=0 — b24-events worker + keep-alive run on the primary instance, not here')
  }

  nitroApp.hooks.hook('close', async () => {
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    if (healthTimer) clearInterval(healthTimer)
    await Promise.all(workers.map(w => w.close()))
  })
})
