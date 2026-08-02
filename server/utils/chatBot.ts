import type { RestCall } from './b24Rest'
import { BOT_AVATAR_BASE64 } from './botAvatar'

/**
 * Chat messages sent AS THE APP, not as the employee whose OAuth token we happen to hold (#316).
 *
 * `im.message.add` writes as the token owner — there is no other behaviour — so import reports and
 * failure notices read as if a colleague were posting them into a shared chat. The failure notice
 * is the worst case: it arrives in the uploader's own personal chat, i.e. from themselves.
 *
 * The fix is a registered chat bot. Facts checked against the REST reference (2026-08-02), because
 * this corner of the API has two live generations:
 *   • `imbot.register` and `imbot.message.add` are DEPRECATED — do not use them in new code;
 *   • the current pair is `imbot.v2.Bot.register` + `imbot.v2.Chat.Message.send`, scope `imbot`;
 *   • registration is IDEMPOTENT by `code` — a repeat call returns the existing bot and overwrites
 *     nothing, so it needs no dedup of our own;
 *   • `botToken` is for webhooks only; under OAuth it must not be sent;
 *   • `eventMode: 'fetch'` (the default) suits a send-only bot — no webhook URL to expose.
 *
 * ⚠ NOT live-verified: no test portal was reachable when this was written. Two documented errors
 * decide whether it works at all on a given portal — `ACCESS_DENIED` («REST API is available only
 * on commercial plans») and `BOT_LIMIT_EXCEEDED` — which is exactly why every caller keeps the old
 * `im.message.add` path as a fallback. Silence is not an option: the failure notice is the only
 * channel that reaches the employee (#288).
 */

/** Bot code — unique within the app, and the idempotency key of the registration call. */
export const BOT_CODE = 'ai-price-import'

/** The bot's face in the chat. `workPosition` shows under the name in Bitrix24. */
export const BOT_PROPERTIES = {
  name: 'AI-импорт прайсов',
  workPosition: 'Импорт документов в CRM'
} as const

export interface RestRequest { method: string, params: Record<string, unknown> }

/** Registration call. Idempotent by `code`; no `botToken` (OAuth context). */
export function buildBotRegister(): RestRequest {
  return {
    method: 'imbot.v2.Bot.register',
    params: {
      fields: {
        code: BOT_CODE,
        properties: { ...BOT_PROPERTIES },
        type: 'bot',
        eventMode: 'fetch'
      }
    }
  }
}

/** Bot id out of the registration envelope (`result.bot.id`), or null if the shape is unexpected. */
export function botIdFromRegister(res: unknown): number | null {
  const bot = (res as { bot?: { id?: unknown } } | null)?.bot
  const id = Number(bot?.id)
  return Number.isFinite(id) && id > 0 ? id : null
}

/**
 * One message from the bot. `dialogId` is the SAME identifier the settings already store
 * (`chat123` for a group chat, a bare user id for a personal one) — no migration of stored values.
 * `urlPreview: false` mirrors `URL_PREVIEW: 'N'` of the old path: link cards are noise here, and an
 * external string that survived neutralisation must not gain a rich preview.
 */
export function buildBotSend(botId: number, dialogId: string, message: string): RestRequest | null {
  const text = message.trim()
  if (!(botId > 0) || !dialogId || !text) return null
  return {
    method: 'imbot.v2.Chat.Message.send',
    params: { botId, dialogId, fields: { message: text, urlPreview: false } }
  }
}

/** Message id out of the send envelope (`result.id`). */
export function messageIdFromBotSend(res: unknown): number | null {
  const id = Number((res as { id?: unknown } | null)?.id)
  return Number.isFinite(id) && id > 0 ? id : null
}

/** List the app's own bots. Used to recover an id we cannot register again (see `registerBot`). */
export function buildBotList(): RestRequest {
  // `limit` is set although a second page is unreachable by construction — the method is scoped to
  // the CURRENT application and the app registers exactly one `code`. Stating the bound costs one
  // line and removes the question; `hasNextPage` is deliberately ignored for the same reason.
  return { method: 'imbot.v2.Bot.list', params: { limit: 50 } }
}

/** Our bot's id out of the list envelope (`result.bots[]`), matched by CODE. */
export function botIdFromList(res: unknown): number | null {
  const bots = (res as { bots?: Array<{ id?: unknown, code?: unknown }> } | null)?.bots
  if (!Array.isArray(bots)) return null
  for (const b of bots) {
    if (String(b?.code ?? '') !== BOT_CODE) continue
    const id = Number(b?.id)
    if (Number.isFinite(id) && id > 0) return id
  }
  return null
}

/**
 * Register the bot for this portal, returning its id.
 *
 * ⚠ REGISTRATION IS NOT THE ONLY WAY TO GET THE ID, and assuming it was is what broke this live
 * (2026-08-02, portal `b24-hrbvzq`): the portal already carried our bot from an earlier install,
 * the app was reinstalled, and `Bot.register` on an already-taken `code` does not hand the existing
 * bot back — `BOT_CODE_ALREADY_TAKEN` is a documented error of the method. We stored 0, every notice
 * fell back to `im.message.add`, and the chat kept showing an employee as the author of the app's
 * own reports — the exact symptom #316 exists to remove, reappearing precisely on a reinstall.
 * ⚠ Scope: this recovers the case where we hold NO id (0). A stale NON-ZERO `bot_id` — the portal
 * dropped the bot but our row still names it — is NOT covered: `resolveBotId` returns a stored id
 * without re-checking it, so those notices keep falling back with no self-healing. Not fixed here
 * on purpose (the bot is set up at install, and a new app version brings a new install event); it
 * is written down so the next report of this symptom is not searched for in the wrong place.
 *
 * So a refusal is followed by ONE list lookup: the bot the portal already has is ours, it carries
 * our `code`, and its id is what we needed all along.
 *
 * Everything is still swallowed into `null`: a portal on a free plan or at its bot limit simply has
 * no bot, and a chat notice that never arrives is worse than one signed by the wrong author.
 */
export async function registerBot(call: RestCall, log?: (msg: string) => void): Promise<number | null> {
  const req = buildBotRegister()
  try {
    const id = botIdFromRegister(await call(req.method, req.params))
    if (id) return id
    log?.('[chat-bot] registration returned no id')
  } catch (e) {
    log?.(`[chat-bot] registration refused: ${errorCode(e)}`)
  }
  const list = buildBotList()
  try {
    const found = botIdFromList(await call(list.method, list.params))
    if (found) log?.('[chat-bot] recovered the id of an already-registered bot')
    return found
  } catch (e) {
    log?.(`[chat-bot] bot list refused: ${errorCode(e)}`)
    return null
  }
}

/**
 * The portal's error CODE, never its prose.
 *
 * Truncating the message was not enough: a REST error text can echo the parameters of the call it
 * rejected, and these calls carry the chat message — i.e. text extracted from a client document,
 * which must never reach the log (project rule). So we pull out the machine-readable code and drop
 * everything else; an unrecognised shape logs as `unknown`, which is still enough to tell «the bot
 * was refused» from «the bot worked».
 */
export function errorCode(e: unknown): string {
  const raw = (e as Error)?.message ?? ''
  const m = /\b([A-Z][A-Z0-9_]{3,49})\b/.exec(raw)
  return m ? m[1]! : 'unknown'
}

/** Injected side of bot-id resolution — makes the stateful part testable without a portal or a DB. */
export interface BotIdDeps {
  /** Stored id for the portal, 0 when none. */
  getBotId: (memberId: string) => Promise<number>
  saveBotId: (memberId: string, botId: number) => Promise<void>
  /** Portal REST transport, resolved lazily — a stored id must cost no transport at all. */
  call: () => Promise<RestCall>
  now?: () => number
  log?: (msg: string) => void
  /** Called once when the portal refuses to register — used to count the degradation (#360). */
  onRefused?: (memberId: string) => void
}

/** How long «this portal cannot have a bot» is believed before asking the portal again. */
export const NO_BOT_TTL_MS = 6 * 60 * 60 * 1000
/** Upper bound on remembered refusals, so a fleet of free-plan portals cannot grow the map forever. */
export const NO_BOT_CACHE_MAX = 500

export interface BotIdCache {
  /** memberId → epoch ms until which we do not retry registration. */
  noBotUntil: Map<string, number>
  /** In-flight registrations, so parallel jobs of ONE portal make ONE REST call. */
  inFlight: Map<string, Promise<number>>
}

export function createBotIdCache(): BotIdCache {
  return { noBotUntil: new Map(), inFlight: new Map() }
}

/**
 * Bot id for a portal, registering it once if needed.
 *
 * Three caches, each for a different failure:
 *   • the POSITIVE answer is durable — it lives in `portal_tokens.bot_id`, so a registered portal
 *     costs one cheap SELECT and no REST at all;
 *   • a NEGATIVE answer is held in memory for `NO_BOT_TTL_MS`, because «no bot» is the NORMAL state
 *     of a free-plan portal and retrying per document would burn a REST call per document forever,
 *     against the portal's own rate limit. It expires so a portal that upgrades its plan starts
 *     signing its messages without anyone remembering to restart the worker;
 *   • an IN-FLIGHT registration is shared, so a batch of jobs from one portal — the normal shape of
 *     an import — fires ONE `Bot.register`, not one per job. Registration is idempotent by code, so
 *     parallel calls would be harmless, just wasteful.
 *
 * The bot is registered AT INSTALL (owner ask: there are no portals predating the `imbot` scope, so
 * nothing has to discover its bot later). This resolver stays the safety net for the case that
 * matters anyway — the install-time registration was refused, so the send path must decide again.
 *
 * Any failure resolves to 0, i.e. «send the old way». Bot plumbing must never break a notification.
 */
export async function resolveBotId(memberId: string, deps: BotIdDeps, cache: BotIdCache): Promise<number> {
  const now = deps.now ?? Date.now
  try {
    const stored = await deps.getBotId(memberId)
    if (stored > 0) return stored
    if ((cache.noBotUntil.get(memberId) ?? 0) > now()) return 0
    const running = cache.inFlight.get(memberId)
    if (running) return await running
    const task = (async () => {
      const id = await registerBot(await deps.call(), deps.log)
      if (!id) {
        // Evict the oldest remembered refusal first: Map keeps insertion order, so the head is the
        // stalest entry. Without this the map is unbounded on a fleet of free-plan portals.
        if (cache.noBotUntil.size >= NO_BOT_CACHE_MAX) {
          const oldest = cache.noBotUntil.keys().next().value
          if (oldest !== undefined) cache.noBotUntil.delete(oldest)
        }
        cache.noBotUntil.set(memberId, now() + NO_BOT_TTL_MS)
        deps.onRefused?.(memberId)
        return 0
      }
      await deps.saveBotId(memberId, id)
      cache.noBotUntil.delete(memberId)
      return id
    })()
    cache.inFlight.set(memberId, task)
    try {
      return await task
    } finally {
      cache.inFlight.delete(memberId)
    }
  } catch {
    return 0
  }
}

/**
 * Unregistration call (#360). Run it BEFORE the portal row is deleted — afterwards there is no
 * token left to speak with, and the bot would stay registered on the portal forever, outliving the
 * app that created it. Personal chats with the bot are removed by the portal along with it.
 */
export function buildBotUnregister(botId: number): RestRequest | null {
  if (!(botId > 0)) return null
  return { method: 'imbot.v2.Bot.unregister', params: { botId } }
}

/**
 * Profile update (#360).
 *
 * Needed because registration is idempotent AND overwrites nothing: a portal that already has the
 * bot will never pick up a new name — or an avatar added later — from `Bot.register`. So the app
 * pushes its profile explicitly whenever the stored id is known.
 *
 * The AVATAR rides here and ONLY here — deliberately not in `Bot.register` (#298). The portal can
 * reject a picture on its own terms (`BOT_AVATAR_INCORRECT_TYPE` / `BOT_AVATAR_INCORRECT_SIZE`),
 * and inside registration that rejection would take the whole call down: no bot at all, and every
 * notice back to being signed with an employee's name. That is a far worse outcome than a bot with
 * a default picture, so the risky field is confined to the call that is already best-effort.
 *
 * Key and format come from the v2 reference pages for `Bot.register`/`Bot.update`, which list the
 * profile sub-fields as name / lastName / workPosition / color / gender / **avatar**, the picture
 * being base64 WITHOUT the `data:` prefix, image only, up to 5000×5000. Ours is 192×192 — the same
 * render as the favicon bundle, so the tab icon, the home-screen icon and the bot are one product.
 * ⚠ Not confirmed against a live portal yet, and an unknown key inside `properties` is ignored
 * silently, so a wrong key would be a no-op rather than an error. Hence the retry below.
 */
export function buildBotProfileUpdate(botId: number, opts: { withAvatar?: boolean } = {}): RestRequest | null {
  if (!(botId > 0)) return null
  const properties = opts.withAvatar === false
    ? { ...BOT_PROPERTIES }
    : { ...BOT_PROPERTIES, avatar: BOT_AVATAR_BASE64 }
  return { method: 'imbot.v2.Bot.update', params: { botId, fields: { properties } } }
}

/**
 * Push the app's own name / position / avatar onto an existing bot. Best-effort — cosmetics never
 * block an import.
 *
 * ⚠ Name and picture travel in ONE call, so a portal that rejects the picture
 * (`BOT_AVATAR_INCORRECT_TYPE` / `_SIZE`) applies NOTHING — and since registration overwrites
 * nothing and this runs once per install, the bot would keep its default name forever. That is not
 * «a bot with a default picture», it is a partial return of the very symptom #316 fixed: notices
 * signed by something that isn't the app. So a failure retries once WITHOUT the avatar — the field
 * that can be refused is also the one we can afford to drop.
 *
 * The retry is unconditional rather than keyed on the avatar error codes: the same «lost the name»
 * outcome follows from any refusal of that first call, and one extra cosmetic call at install time
 * costs nothing.
 */
export async function pushBotProfile(botId: number, call: () => Promise<RestCall>, log?: (msg: string) => void): Promise<void> {
  const req = buildBotProfileUpdate(botId)
  if (!req) return
  try {
    await (await call())(req.method, req.params)
    return
  } catch (e) {
    log?.(`[chat-bot] profile update refused: ${errorCode(e)}`)
  }
  const plain = buildBotProfileUpdate(botId, { withAvatar: false })
  if (!plain) return
  try {
    await (await call())(plain.method, plain.params)
  } catch (e) {
    log?.(`[chat-bot] profile update refused without avatar: ${errorCode(e)}`)
  }
}

/**
 * Forget a portal's remembered refusal (#360 review). Called on uninstall: without it a portal that
 * was refused, then uninstalled and reinstalled within `NO_BOT_TTL_MS`, would skip registration at
 * install and silently keep signing its notices with an employee's name for the rest of the window.
 */
export function forgetPortalBot(memberId: string, cache: BotIdCache): void {
  cache.noBotUntil.delete(memberId)
  cache.inFlight.delete(memberId)
}

/** «У портала есть бот?» — one place, so an inversion cannot be reintroduced inline in a route. */
export function botIsReady(botId: number): boolean {
  return botId > 0
}
