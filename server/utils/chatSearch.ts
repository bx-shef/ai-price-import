import type { RestCall } from './b24Rest'

// Backend core for the chat picker (settings form: notify/error chat). Pure over the
// injected `call(method, params)` so it unit-tests without the network; the route binds
// the real portal transport + identity (see chat-search.get.ts).
//
// Two B24 `im` methods, one normalized shape ({ value: DIALOG_ID, label: title }):
//   - query ≥3 chars  → im.search.chat.list (FIND) — search all chats by title;
//   - shorter/empty    → im.recent.list (SKIP_DIALOG=Y) — recent GROUP chats (1-1 dialogs
//     excluded: we post to group chats/channels, not to a person).
// Only chats we may post to are kept (im.search.chat.list `restrictions.send !== false`).
// The stored value is the B24 DIALOG_ID `chat<id>` — exactly what im.message.add wants
// (chatNotify.sendChatMessage).
//
// IMPORTANT — envelope contract. This app's RestCall (b24Sdk.makeSdkRestCall) returns the
// UNWRAPPED `result`, NOT the full `{result,total,next}` envelope. Verified live via
// b24-dev-mcp: im.search.chat.list → `result` is an ARRAY of chats; im.recent.list →
// `result` is an OBJECT ({ items:[…] }). Because `total`/`next` are not reachable through
// this transport, the picker serves a SINGLE page (no load-more): up to CHAT_SEARCH_LIMIT
// search hits or CHAT_RECENT_LIMIT recent groups — enough to pick a target. Real paging
// would need the raw envelope (follow-up).

/** One pickable chat: `value` is the B24 DIALOG_ID (`chat<id>`), `label` its title. The
 *  index signature keeps it assignable to AsyncSearchSelect's `Record<string, unknown>`. */
export interface ChatOption {
  value: string
  label: string
  [key: string]: unknown
}

/** Min chars before a non-empty query searches (im.search.chat.list expects ≥3). */
export const CHAT_SEARCH_MIN = 3
/** Page size for the search (im.search.chat.list). Since this transport can't reach
 *  total/next (unwrapped result → no cursor), we serve one wide page: the method caps at 50. */
export const CHAT_SEARCH_LIMIT = 50
/** Page size for the default recent list (im.recent.list; max 200). */
export const CHAT_RECENT_LIMIT = 50

/** Build a chat DIALOG_ID (`chat<id>`) from a numeric id, or null if not a positive
 *  integer (defends against malformed rows — a bad id must not become a target). */
export function chatDialogId(id: unknown): string | null {
  const n = typeof id === 'number' ? id : Number(id)
  return Number.isInteger(n) && n > 0 ? `chat${n}` : null
}

/** True unless the chat explicitly forbids sending (default: allowed). Reads
 *  `restrictions.send` (im.search.chat.list) — only an explicit `false` excludes it. */
function canSend(chat: Record<string, unknown>): boolean {
  const r = chat.restrictions as Record<string, unknown> | undefined
  return !(r && r.send === false)
}

/** Normalize the UNWRAPPED im.search.chat.list result (an ARRAY of chats) → options.
 *  Non-array input (bad transport) yields an empty list rather than throwing. */
export function normalizeChatSearch(result: unknown): ChatOption[] {
  const rows = Array.isArray(result) ? result as unknown[] : []
  const items: ChatOption[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue // a null/primitive element must not crash the map
    const row = raw as Record<string, unknown>
    if (!canSend(row)) continue
    const value = chatDialogId(row.id)
    const label = String(row.name ?? '').trim()
    if (value && label) items.push({ value, label })
  }
  return items
}

/** Normalize the UNWRAPPED im.recent.list result (an OBJECT `{ items:[…] }`) → group-chat
 *  options. 1-1 user dialogs are dropped (type === 'user') as a guard on top of SKIP_DIALOG. */
export function normalizeRecentChats(result: unknown): ChatOption[] {
  const obj = (result ?? {}) as Record<string, unknown>
  const rows = Array.isArray(obj.items) ? obj.items as unknown[] : []
  const items: ChatOption[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue // guard a null/primitive element
    const row = raw as Record<string, unknown>
    if (row.type === 'user') continue // 1-1 dialog (belt-and-braces on top of SKIP_DIALOG)
    // Read-only channels / broadcast chats can't be posted to (im.message.add would fail) —
    // skip them like canSend does for the search branch. Only an explicit false excludes.
    if (row.text_field_enabled === false) continue
    const value = chatDialogId(row.chat_id ?? row.id)
    const label = String(row.title ?? '').trim()
    if (value && label) items.push({ value, label })
  }
  return items
}

/** A single page of chat options (no cursor — see the envelope note above). */
export interface ChatSearchPage {
  items: ChatOption[]
  hasMore: boolean
}

/**
 * Search a portal's chats: query ≥3 chars → im.search.chat.list; else recent group chats.
 * `call` carries the portal identity (bound by the route). Pure otherwise; a REST error
 * propagates (the route maps it to a status).
 */
export async function searchChats(call: RestCall, query: string): Promise<ChatSearchPage> {
  const q = query.trim()
  if (q.length >= CHAT_SEARCH_MIN) {
    const result = await call('im.search.chat.list', { FIND: q, OFFSET: 0, LIMIT: CHAT_SEARCH_LIMIT })
    return { items: normalizeChatSearch(result), hasMore: false }
  }
  // SKIP_DIALOG=Y drops 1-1 dialogs; SKIP_OPENLINES=Y drops open-line chats (a bot can't
  // freely post there). text_field_enabled=false rows are filtered in normalizeRecentChats.
  const result = await call('im.recent.list', { SKIP_DIALOG: 'Y', SKIP_OPENLINES: 'Y', OFFSET: 0, LIMIT: CHAT_RECENT_LIMIT })
  return { items: normalizeRecentChats(result), hasMore: false }
}
