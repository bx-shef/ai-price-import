import { OP_COOKIE, operatorAllowed } from '../../utils/operatorSession'
import { handleAnnouncementOp } from '../../utils/announcementOpsHandler'
import { announcementRedis } from '../../utils/announcementRedis'
import { clearAnnouncement, writeAnnouncement } from '../../utils/announcementStore'
import { connectionOptions } from '../../queue/connection'
import { MAX_BROADCAST_PORTALS, broadcastAnnouncement } from '../../utils/announcementBroadcast'
import { shouldBroadcast } from '~/utils/announcementDelivery'
import { makePortalSdkCall, sdkPortalDeps } from '../../utils/b24Sdk'
import { listPortalStatus } from '../../utils/tokenStore'
import { query } from '../../db/client'
import { LANDING_MARKET_CODE } from '~/utils/landing'
import { MAX_ANNOUNCEMENT_BODY_BYTES } from '~/config/announcement'

// POST /api/ops/announcement — завести, посмотреть или снять объявление издателя (#469).
// Гейт — сессия оператора, как у остальных `/api/ops/*`. Отдельного CSRF-заголовка в этом проекте
// нет ни у одного служебного роута: кука `SameSite=Lax` не уходит с кросс-сайтового POST, и второй
// слой добавлять надо всем сразу или никому. ⚠ В соседнем репозитории такой заголовок есть — не
// переносить сюда описание оттуда, не перенеся саму проверку.
//
// Действия: `preview` (проверить и посмотреть, ничего не пишет), `publish` (требует `confirm:true`),
// `clear` (снять досрочно). Решение целиком в чистой `handleAnnouncementOp` — роут только связывает
// её с живым хранилищем.
export default defineEventHandler(async (event) => {
  if (!operatorAllowed(getCookie(event, OP_COOKIE), process.env, Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  // ⚠ Кап тела ДО чтения: картинка едет в JSON, и без этого `readBody` разобрал бы сколь угодно
  // большой документ в память процесса. Роут под сессией оператора, то есть сторона доверенная, —
  // но «доверенная сторона» это про намерение, а не про случайно выбранный файл на 200 МБ.
  const declared = Number(getHeader(event, 'content-length') || 0)
  if (Number.isFinite(declared) && declared > MAX_ANNOUNCEMENT_BODY_BYTES) {
    setResponseStatus(event, 413)
    return { error: `тело больше ${Math.round(MAX_ANNOUNCEMENT_BODY_BYTES / 1024)} КБ — уменьшите картинку` }
  }
  const body = await readBody(event).catch(() => ({})) as {
    action?: unknown
    confirm?: unknown
    draft?: Record<string, unknown>
  }
  const redis = announcementRedis(connectionOptions())
  const res = await handleAnnouncementOp(body?.action, body?.draft ?? {}, body?.confirm, {
    publish: a => writeAnnouncement(redis, a, Date.now()),
    clear: () => clearAnnouncement(redis),
    now: () => Date.now()
  })
  setResponseStatus(event, res.status)
  // ⚠ Рассылка живого сигнала — ПОСЛЕ успешной записи и только для действий, которые меняют
  // объявление (#478). До этого объявление доезжало лишь при открытии рабочего экрана, то есть у
  // сотрудника с уже открытой вкладкой не появлялось вовсе.
  //
  // ⚠ Рассылка НЕ вправе завалить операцию: объявление уже записано и доедет запасным путём, а её
  // отказ — строка в отчёте, а не ошибка. Но и молчать нельзя: молчаливо провалившаяся рассылка
  // неотличима от «никто не открывал экран», и владелец ждал бы реакции на объявление, которого
  // никто не получил. Поэтому сводка едет оператору в ответе.
  //
  // ⚠ Снятие объявления рассылается ТОЖЕ: иначе снятое продолжало бы висеть у всех, кто держит
  // вкладку открытой, — то есть ровно у тех, ради кого сигнал и заводился. Уже ОТКРЫТОЕ окно при
  // этом не закрывается: гасить его под руками у читающего человека хуже, чем дать дочитать.
  // Условие — в чистой `shouldBroadcast`: инлайн в роуте его не покрывал ни один тест, а мутация
  // «рассылать и на предпросмотр» превращала каждое нажатие «Проверить» в обход всех порталов.
  if (shouldBroadcast(body?.action, res.status)) {
    try {
      const infra = sdkPortalDeps({
        query,
        clientId: process.env.B24_CLIENT_ID ?? '',
        clientSecret: process.env.B24_CLIENT_SECRET ?? '',
        encKey: process.env.B24_TOKEN_ENC_KEY ?? '',
        now: () => Date.now()
      })
      const broadcast = await broadcastAnnouncement({
        // ⚠ Предел передаётся ЯВНО. У `listPortalStatus` свой дефолт (500), и он резал выборку
        // РАНЬШЕ, чем рассылка успевала об этом узнать: признак «выборка обрезана» сравнивал длину
        // уже урезанного списка со своим капом и потому не становился истинным никогда. Порталы
        // сверх пятисот молча не получали бы сигнал, а оператор читал «доставлено всем».
        // Берём на один больше капа — иначе «ровно кап» неотличимо от «обрезано».
        listPortals: async () => (await listPortalStatus(query, MAX_BROADCAST_PORTALS + 1)).map(p => p.memberId),
        callFor: async m => (await makePortalSdkCall(m, infra))?.call ?? null,
        moduleId: String(process.env.NUXT_PUBLIC_B24_MARKET_CODE || LANDING_MARKET_CODE),
        log: msg => console.info(msg)
      })
      return { ...(res.body as Record<string, unknown>), broadcast }
    } catch {
      // Читаем это как «разослать не удалось целиком» — например, база недоступна. Операция всё
      // равно состоялась, поэтому отдаём тело как есть с явной пометкой, а не 500.
      return { ...(res.body as Record<string, unknown>), broadcast: null }
    }
  }
  return res.body
})
