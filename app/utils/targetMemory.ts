import type { TargetRef } from '~/types/mapping'

// Remember the target the employee picked BY HAND for the current import session (#349).
//
// Why remember at all: a person who feeds the app invoices all day sends them to the same place, and
// re-picking сущность → направление → стадию on every batch is pure friction.
//
// Why sessionStorage and not localStorage (owner's decision): the memory dies with the tab, so a
// shared office computer keeps nothing for the next person. What is stored is only IDENTIFIERS of a
// portal setting — no document, no counterparty, no file name — but the tab-lifetime rule is the same
// one the rest of this screen follows, and one rule is easier to keep honest than two.
//
// Why keyed by portal: sessionStorage is already per-tab, so two people never share a slot — but one
// tab CAN be navigated from one portal to another, and a направление id means nothing outside the
// portal it came from. The portal domain is the only identity the frame hands the client (`member_id`
// is deliberately server-side only), and it is exactly the scope that matters here.
//
// Pure + injected storage → unit-tested without a browser.

/** Minimal Storage surface used here (sessionStorage in the browser, a fake in tests). */
export interface TargetStore {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/** Storage key for one portal. No portal yet (frame not ready) → a neutral slot, so a choice made
 *  before init cannot be attributed to the wrong portal later.
 *
 *  ⚠ Префикс сменился вместе с именем продукта (#412), и это забывает выбор направления во всех
 *  открытых вкладках у всех порталов — ровно один раз, на выкате. Терпимо: память живёт до
 *  закрытия вкладки by design, а следующая пачка сохранит выбор заново. Цена названа, чтобы её не
 *  искали как дефект. */
export function targetMemoryKey(portalDomain?: string | null): string {
  const d = String(portalDomain ?? '').trim().toLowerCase() || 'unknown'
  return `ai-price-import.target.${d}`
}

/** Serialise a target for storage. `null` clears the memory (employee went back to the default). */
export function writeTarget(store: TargetStore, key: string, target: TargetRef | null): void {
  try {
    if (!target || !(target.entityTypeId > 0)) {
      store.removeItem(key)
      return
    }
    // Only identifiers — captions/labels are re-read from the portal, never trusted from storage.
    store.setItem(key, JSON.stringify({
      entityTypeId: target.entityTypeId,
      ...(target.categoryId != null ? { categoryId: target.categoryId } : {}),
      ...(target.stageId ? { stageId: target.stageId } : {})
    }))
  } catch {
    // Storage can throw (private mode, quota). Remembering is a convenience — never break the import.
  }
}

/**
 * What to do with the remembered target when the admin changed the portal settings (#443).
 *
 * Админ поменял настройки, и событие разошлось всем сотрудникам. Решение владельца 09.08.2026: **память обновляем**, ручной выбор сотрудника не переживает правку.
 * Смысл рассылки в том, чтобы у всех стало как настроил админ; память, пережившая её, ровно это и
 * отменяла бы — причём молча и у каждого по-своему.
 *
 * ⚠ ВОЗВРАЩАЕМ ИМЕННО «АВТО (ПО ПРАВИЛАМ)», А НЕ ЦЕЛЬ ПО УМОЛЧАНИЮ. Разница не косметическая, и
 * первая редакция на ней и сломалась. `mapping.defaultTarget` **всегда конкретен** —
 * `parsePortalSettings` подставляет `FALLBACK_TARGET` (сделка, воронка 0), пустого значения там не
 * бывает. Проставив его сотруднику, мы кладём в задание `target`, а он на сервере становится
 * `manualOverride` и в `resolveTarget` бьёт ПЕРВЫМ приоритетом — выше правил маршрутизации. То есть
 * админ, поправивший что угодно в настройках (хоть синоним единицы измерения), тем же нажатием
 * отключал бы собственные правила «какие документы куда вносить» у всего портала. «Авто» —
 * состояние по умолчанию, так что задело бы почти всех и молча.
 *
 * `null` же не кладёт в форму поля `target` вовсе, и сервер идёт по правилам плюс цель по
 * умолчанию — то есть ровно «как настроил админ», без подмены механизма.
 *
 * ⚠ Цена названа: сотрудник, выбравший направление руками и не начавший импорт, вернётся на «Авто».
 * Это сознательно — админ правит настройки редко и осмысленно, — но НЕ молча: экран обязан показать
 * новое состояние (иначе он утверждал бы неправду о том, куда уедет документ).
 *
 * ⚠ ЕДИНСТВЕННОЕ исключение — идущая пачка: подменив цель на середине, мы отправили бы её остаток
 * не туда, куда ушло начало, и человек узнал бы об этом только из CRM.
 *
 * ⚠ ОТЛОЖЕННОЕ — НЕ ОТМЕНЁННОЕ. `adopt:false` означает «не сейчас», и вызывающий ОБЯЗАН применить
 * правку на спаде прогона. Иначе она пропадает навсегда: счётчик правок больше не изменится, и
 * сотрудник останется на своём выборе до нового сохранения админом или до перезагрузки вкладки —
 * то есть рассылку потеряет ровно тот, ради кого она делалась, активно грузящий документы.
 *
 * ⚠ Заморозка закрывает ОДНО поле: остальные настройки (единицы, поведение при ненайденном товаре,
 * чаты) сервер читает в момент обработки задания, и на уже принятые задания правка влияет.
 * Обещать «пачка идёт на прежних настройках» целиком нельзя.
 */
export function applySettingsChangeToTarget(opts: { importing: boolean }): { adopt: boolean, target: null } {
  return { adopt: !opts.importing, target: null }
}

/**
 * Read back a remembered target. Returns null on anything unexpected — corrupt JSON, wrong shape, a
 * non-positive entity type. The caller then falls back to the portal's default, which is also what
 * must happen when the направление/стадия has since been deleted or renamed: this function cannot
 * know that, so the CALLER validates the restored value against the live cascade before using it.
 */
export function readTarget(store: TargetStore, key: string): TargetRef | null {
  try {
    const raw = store.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<TargetRef> | null
    if (!parsed || typeof parsed !== 'object') return null
    const entityTypeId = Number(parsed.entityTypeId)
    if (!Number.isFinite(entityTypeId) || entityTypeId <= 0) return null
    const categoryId = Number(parsed.categoryId)
    const stageId = typeof parsed.stageId === 'string' && parsed.stageId ? parsed.stageId : undefined
    return {
      entityTypeId,
      ...(Number.isFinite(categoryId) && categoryId >= 0 ? { categoryId } : {}),
      ...(stageId ? { stageId } : {})
    } as TargetRef
  } catch {
    return null
  }
}
