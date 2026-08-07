import { describe, expect, it, vi } from 'vitest'
import { buildProductRow, buildProductRows, computeOpportunity, createTargetItem, ownerTypeCode, setProductRows, supportsOpportunity } from '../server/utils/crmWrite'
import { findCompanyByTaxId } from '../server/utils/companyLookup'
import { DESCRIPTION_TYPE_BB, TODO_COLOR_CLEAN, TODO_COLOR_ISSUES, activityMarkerFilter, buildActivityInput, buildActivityMarkerFields, buildTodoActivity, entityOpenPath } from '../server/utils/todoActivity'

describe('computeOpportunity', () => {
  // Контракт: сюда приходят строки от buildProductRow, где `price` УЖЕ валовая (#302).
  // Сумма = Σ round2(price × qty), налог сверху не добавляется никогда.
  it('суммирует валовые строки как есть', () => {
    expect(computeOpportunity([
      { price: 100, quantity: 2, taxRate: 22, taxIncluded: 'Y' },
      { price: 120, quantity: 1, taxRate: 20, taxIncluded: 'N' }
    ])).toBe(320)
  })
  it('пустой список = 0', () => {
    expect(computeOpportunity([])).toBe(0)
  })
  it('non-finite price → 0; missing quantity → 1 (matches buildProductRow clamps)', () => {
    expect(computeOpportunity([{ price: NaN, quantity: 2, taxIncluded: 'Y' }])).toBe(0)
    expect(computeOpportunity([{ price: 100, quantity: NaN, taxIncluded: 'Y' }])).toBe(100)
  })
  // #347: флаг `taxIncluded` теперь ЗЕРКАЛИТ ДОКУМЕНТ (он решает, что портал печатает в колонке
  // «Цена»), поэтому нетто-счёт несёт 'N' рядом с уже валовой ценой. Прежняя версия читала флаг
  // и на таком наборе добавляла НДС ВТОРОЙ раз: 10 320 превращалось в 12 384. Тест держит именно
  // эту связку — «строка от buildProductRow с флагом N» — а не абстрактное «сумма считается».
  it('НЕ добавляет НДС по флагу «N» — цена уже валовая (иначе задвоение налога)', () => {
    const row = buildProductRow({ productName: 'Мешок', price: 0.86, quantity: 10000, taxRate: 20, priceIncludesVat: false, measureCode: 796 }, 10)
    expect(row.taxIncluded).toBe('N') // документ печатает цены без НДС
    expect(computeOpportunity([row])).toBe(10320) // не 12 384
  })
  it('сумма строки округляется один раз (не по единице)', () => {
    const row = buildProductRow({ productName: 'x', price: 10.11, quantity: 3, taxRate: 20, priceIncludesVat: false, measureCode: 796 }, 10)
    expect(computeOpportunity([row])).toBe(36.40)
  })
})

describe('supportsOpportunity', () => {
  it('true for lead/deal/quote/smart-invoice, false for smart-process and others', () => {
    expect(supportsOpportunity(1)).toBe(true) // lead — money-bearing, #135 (was false)
    expect(supportsOpportunity(2)).toBe(true)
    expect(supportsOpportunity(7)).toBe(true)
    expect(supportsOpportunity(31)).toBe(true)
    expect(supportsOpportunity(1032)).toBe(false)
  })
})

describe('crmWrite', () => {
  it('ownerTypeCode', () => {
    expect(ownerTypeCode(1)).toBe('L') // lead — live-verified ('T1' → ACCESS_DENIED), #135
    expect(ownerTypeCode(2)).toBe('D')
    expect(ownerTypeCode(7)).toBe('Q')
    expect(ownerTypeCode(31)).toBe('SI')
    // Dynamic smart process: 'T' + HEX id (live-verified: 'T460' OK, decimal 'T1120' →
    // ENTITY_TYPE_NOT_SUPPORTED — the decimal form silently broke every SP product write).
    expect(ownerTypeCode(1120)).toBe('T460')
    expect(ownerTypeCode(1030)).toBe('T406')
  })
  it('buildProductRow: inclusive price kept at DOCUMENT precision + productId omitted when absent', () => {
    const row = buildProductRow({ productName: 'x', price: 4.355, quantity: 2, taxRate: 22, priceIncludesVat: true, measureCode: 796 }, 10)
    expect(row.taxIncluded).toBe('Y')
    // NOT bumped to 4.36: the header rounds the LINE (4.355×2 → 8.71); a kopeck-rounded unit
    // would make the portal tab 8.72 — a cent off the header for no reason.
    expect(row.price).toBe(4.355)
    expect(row).not.toHaveProperty('productId')
  })
  // #302 (live-verified): the portal treats row `price` as ALWAYS gross and ignores taxIncluded in
  // its math — a net price written as-is undershot every row by the whole VAT. The builder must
  // convert net→gross itself; the flag mirrors the DOCUMENT (#347), so a net-priced invoice gets
  // 'N' and the card prints 0,86 — the number on paper — while storing the gross 1,032.
  it('buildProductRow: net price converted to gross, NOT rounded to kopecks (the reported invoice)', () => {
    const row = buildProductRow({ productName: 'Мешок', price: 0.86, quantity: 10000, taxRate: 20, priceIncludesVat: false, measureCode: 796 }, 10)
    // exactly 1.032 — round2 would give 1.03 → ×10 000 = 10 300; float noise (1.0319999…) must not leak
    expect(row.price).toBe(1.032)
    expect(row.taxIncluded).toBe('N')
    // the portal computes the row sum as price×qty — it must land on the printed «Всего к оплате»
    expect(Math.round((row.price as number) * (row.quantity as number) * 100) / 100).toBe(10320)
  })
  it('buildProductRow: net with null/zero rate stays as-is; fractional rate converts', () => {
    expect(buildProductRow({ productName: 'x', price: 100, quantity: 1, taxRate: null, priceIncludesVat: false, measureCode: 796 }, 10).price).toBe(100)
    expect(buildProductRow({ productName: 'x', price: 100, quantity: 1, taxRate: 0, priceIncludesVat: false, measureCode: 796 }, 10).price).toBe(100)
    expect(buildProductRow({ productName: 'x', price: 1, quantity: 1, taxRate: 8.5, priceIncludesVat: false, measureCode: 796 }, 10).price).toBe(1.085)
  })
  // Pin the 6-dp contract BELOW kopeck level: every other gross pin has ≤3 decimals, so a round3/
  // round4 mutant survived the suite while diverging in production (0.33 @22% → 0.4026; round3
  // writes 0.403 → ×10 000 = 4 030 vs opportunity 4 026 — the #302 mismatch at smaller scale).
  it('buildProductRow: gross keeps ≥4 decimals (round6, not a coarser rounding)', () => {
    expect(buildProductRow({ productName: 'x', price: 0.33, quantity: 1, taxRate: 22, priceIncludesVat: false, measureCode: 796 }, 10).price).toBe(0.4026)
    expect(buildProductRow({ productName: 'x', price: 0.33, quantity: 1, taxRate: 8.5, priceIncludesVat: false, measureCode: 796 }, 10).price).toBe(0.35805)
    // The NET input is NOT quantized to kopecks either: 0.335 stays 0.335 → ×1.085 = 0.363475.
    // (A kopeck-rounding mutant would emit 0.34 → 0.3689.)
    expect(buildProductRow({ productName: 'x', price: 0.335, quantity: 1, taxRate: 8.5, priceIncludesVat: false, measureCode: 796 }, 10).price).toBe(0.363475)
  })
  // Sub-kopeck unit price × large qty — the reviewer-found sibling of the reported invoice:
  // header math uses RAW document precision (round2(0.8654×10 000)=8 654 → ×1.2 = 10 384.80),
  // so kopeck-rounding the input (0.8654→0.87 → gross 1.044 → tab 10 440.00) diverged header
  // vs products tab by 55.20 — the same #302 symptom one step earlier. Quantities likewise
  // (weights in tonnes: 1.3754 → 1.38 shifted a line by 0.55).
  it('buildProductRow: sub-kopeck net and fractional quantity keep document precision', () => {
    const row = buildProductRow({ productName: 'x', price: 0.8654, quantity: 10000, taxRate: 20, priceIncludesVat: false, measureCode: 6 }, 10)
    expect(row.price).toBe(1.03848)
    expect(Math.round((row.price as number) * (row.quantity as number) * 100) / 100).toBe(10384.8)
    expect(buildProductRow({ productName: 'x', price: 100, quantity: 1.3754, taxRate: 20, priceIncludesVat: false, measureCode: 796 }, 10).quantity).toBe(1.3754)
  })
  it('buildProductRows maps items via resolver (net doc → gross rows)', () => {
    const rows = buildProductRows(
      [{ name: 'a', price: 10, quantity: 1 }, { name: 'b', price: 20, quantity: 3 }],
      () => ({ taxRate: 20, measureCode: 796 }),
      false
    )
    expect(rows).toHaveLength(2)
    expect(rows[1]!.taxIncluded).toBe('N') // документ печатает цены без НДС → карточка покажет 20
    expect(rows[1]!.price).toBe(24) // 20 net @20% → 24 gross (хранится валовая, показывается 20)
    expect(rows[1]!.sort).toBe(20)
  })
  // #348: единичный buildProductRow покрыт отдельно, но в бою вызывается ИМЕННО этот маппер —
  // мутация «забыть прокинуть r.productId в buildProductRow» иначе прошла бы молча, и найденный
  // товар снова уезжал бы с названием поставщика.
  it('buildProductRows: найденной позиции — id без названия, ненайденной — название', () => {
    const rows = buildProductRows(
      [{ name: 'Мешок из накладной', price: 10, quantity: 1 }, { name: 'Чего нет в каталоге', price: 20, quantity: 1 }],
      (_it, i) => ({ taxRate: 20, measureCode: 796, productId: i === 0 ? 42 : undefined }),
      false
    )
    expect(rows[0]!.productId).toBe(42)
    expect(rows[0]).not.toHaveProperty('productName')
    expect(rows[1]).not.toHaveProperty('productId')
    expect(rows[1]!.productName).toBe('Чего нет в каталоге')
  })
  // The invariant the live E2E now also holds: what the portal computes from the written rows
  // (Σ price×qty) equals our computeOpportunity over the same rows — header and product tab agree.
  it('row sum computed the portal way equals computeOpportunity (net doc)', () => {
    const rows = buildProductRows(
      [
        { name: 'Мешок', price: 0.86, quantity: 10000 },
        { name: 'Кабель', price: 1.2, quantity: 500 },
        { name: 'Без НДС', price: 50, quantity: 3 }
      ],
      (_it, i) => ({ taxRate: i === 2 ? null : 20, measureCode: 796 }),
      false
    )
    const portalSum = Math.round(rows.reduce((s, r) => s + (r.price as number) * (r.quantity as number), 0) * 100) / 100
    expect(portalSum).toBe(computeOpportunity(rows))
    expect(portalSum).toBe(10320 + 720 + 150)
  })
  it('createTargetItem + setProductRows call REST correctly', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ item: { id: 55 } })
      .mockResolvedValueOnce({ productRows: [] })
    const id = await createTargetItem({ entityTypeId: 2, categoryId: 1 }, { title: 't' }, call)
    expect(id).toBe(55)
    expect(call).toHaveBeenCalledWith('crm.item.add', { entityTypeId: 2, fields: { title: 't', categoryId: 1 } })
    await setProductRows(2, 55, [{ price: 1 }], call)
    expect(call).toHaveBeenLastCalledWith('crm.item.productrow.set', { ownerType: 'D', ownerId: 55, productRows: [{ price: 1 }] })
  })

  it('stage rides in the ADD for deals AND leads (one step); a lead drops only the categoryId', async () => {
    // Deal: stageId + categoryId in the add.
    const dealCall = vi.fn().mockResolvedValueOnce({ item: { id: 7 } })
    await createTargetItem({ entityTypeId: 2, categoryId: 3, stageId: 'C3:NEW' }, { title: 'd' }, dealCall)
    expect(dealCall).toHaveBeenCalledTimes(1)
    expect(dealCall).toHaveBeenCalledWith('crm.item.add', { entityTypeId: 2, fields: { title: 'd', categoryId: 3, stageId: 'C3:NEW' } })

    // Lead: ONE crm.item.add with stageId; the categoryId is dropped (leads have no category).
    const leadCall = vi.fn().mockResolvedValueOnce({ item: { id: 9 } })
    const id = await createTargetItem({ entityTypeId: 1, categoryId: 3, stageId: 'IN_PROCESS' }, { title: 'l' }, leadCall)
    expect(id).toBe(9)
    expect(leadCall).toHaveBeenCalledTimes(1)
    expect(leadCall).toHaveBeenCalledWith('crm.item.add', { entityTypeId: 1, fields: { title: 'l', stageId: 'IN_PROCESS' } })
  })
})

describe('companyLookup', () => {
  it('returns minimal company id, strips non-digits', async () => {
    const call = vi.fn().mockResolvedValue([{ ENTITY_ID: '30' }, { ENTITY_ID: '12' }])
    expect(await findCompanyByTaxId('УНП 190 000 000', call)).toBe(12)
    expect(call).toHaveBeenCalledWith('crm.requisite.list', expect.objectContaining({ filter: expect.objectContaining({ RQ_INN: '190000000' }) }))
  })
  it('null when none / empty tax id', async () => {
    expect(await findCompanyByTaxId('', vi.fn())).toBeNull()
    expect(await findCompanyByTaxId('123', vi.fn().mockResolvedValue([]))).toBeNull()
  })
})

describe('disk + activity', () => {
  it('entityOpenPath', () => {
    expect(entityOpenPath(1, 8)).toBe('/crm/lead/details/8/') // lead, #135
    expect(entityOpenPath(2, 5)).toBe('/crm/deal/details/5/')
    expect(entityOpenPath(1030, 9)).toBe('/crm/type/1030/details/9/')
  })
  it('чистый импорт: дело закрыто, зелёное, срок «сейчас», без напоминания', () => {
    const input = buildActivityInput({ entityTypeId: 2, entityId: 5, rowCount: 1, warnings: [], nowMs: 1_000_000 })
    const a = buildTodoActivity(input)
    expect(a.ownerTypeId).toBe(2)
    expect(a.colorId).toBe(TODO_COLOR_CLEAN)
    expect(a.deadline).toBe(new Date(1_000_000).toISOString())
    // Напоминать о том, что всё хорошо, значит обесценить уведомления вообще.
    expect(a.pingOffsets).toBeUndefined()
    expect(input.clean).toBe(true)
  })

  it('есть замечания: дело НЕ закрыто, розовое, срок +15 минут, с напоминанием', () => {
    const input = buildActivityInput({ entityTypeId: 2, entityId: 5, rowCount: 1, warnings: ['товар не найден'], nowMs: 1_000_000 })
    const a = buildTodoActivity(input)
    expect(input.clean).toBe(false)
    expect(a.colorId).toBe(TODO_COLOR_ISSUES)
    expect(a.deadline).toBe(new Date(1_000_000 + 15 * 60_000).toISOString())
    expect(a.pingOffsets).toEqual([0])
  })

  it('признак чистоты берётся из ТЕХ ЖЕ warnings, что печатаются в теле', () => {
    // Два независимых источника разъехались бы, и дело закрывалось бы при видимом списке проблем.
    const input = buildActivityInput({ entityTypeId: 2, entityId: 5, rowCount: 1, warnings: ['есть проблема'], nowMs: 0 })
    expect(input.clean).toBe(false)
    expect(input.description).toContain('Проблемы (1)')
  })

  it('ответственный — загрузивший документ, а не владелец токена', () => {
    // Без этого дело доставалось администратору, чьим OAuth-токеном работает приложение: у него
    // копились чужие импорты, а человек, загрузивший накладную, своего дела не видел вовсе.
    const a = buildTodoActivity(buildActivityInput({
      entityTypeId: 2, entityId: 5, rowCount: 1, warnings: [], nowMs: 0, responsibleId: 17
    }))
    expect(a.responsibleId).toBe(17)
  })

  it('загрузивший неизвестен → поле НЕ ставим, а не шлём мусор', () => {
    // Несуществующий id отвергается порталом целиком, и дела не будет вовсе; без поля портал
    // подставит владельца токена — хуже, но не «ничего».
    const a = buildTodoActivity(buildActivityInput({ entityTypeId: 2, entityId: 5, rowCount: 1, warnings: [], nowMs: 0 }))
    expect(a).not.toHaveProperty('responsibleId')
  })

  it('маркер приложения едет ОДНИМ вызовом с разметкой', () => {
    // Два отдельных `update` стоили бы лишнего обращения к порталу на каждый импорт.
    const f = buildActivityMarkerFields('SH_APP_IMPORT_PRICE_AI', 'job-1')
    expect(f).toEqual({ DESCRIPTION_TYPE: DESCRIPTION_TYPE_BB, ORIGINATOR_ID: 'SH_APP_IMPORT_PRICE_AI', ORIGIN_ID: 'job-1' })
  })

  it('фильтр журнала ищет ТОЛЬКО свои дела, а по заданию — конкретное', () => {
    // Без `ORIGINATOR_ID` выборка забрала бы чужие дела портала; с `ORIGIN_ID` тот же фильтр
    // служит защитой от второго дела при повторной доставке задания.
    expect(activityMarkerFilter('SH_APP_IMPORT_PRICE_AI')).toEqual({ ORIGINATOR_ID: 'SH_APP_IMPORT_PRICE_AI' })
    expect(activityMarkerFilter('SH_APP_IMPORT_PRICE_AI', 'job-1')).toEqual({ ORIGINATOR_ID: 'SH_APP_IMPORT_PRICE_AI', ORIGIN_ID: 'job-1' })
  })

  it('контрагент найден → владелец дела КОМПАНИЯ, а не созданная сущность', () => {
    const input = buildActivityInput({ entityTypeId: 2, entityId: 5, companyId: 42, rowCount: 1, warnings: [], nowMs: 0 })
    expect(input.ownerTypeId).toBe(4)
    expect(input.ownerId).toBe(42)
  })
})

describe('ownerTypeCode — hex с буквами и регистр', () => {
  it('буквенный hex — строчный, как в доке (PREFIX = T + dechex, нижний регистр)', () => {
    // 1054 = 0x41E. Портал принимает любой регистр (проверено вживую), но канонична строчная
    // форма из офдоки — тест ловит случайный .toUpperCase(), который мимо буквенно-чистых
    // пинов (0x460, 0x406) прошёл бы незамеченным.
    expect(ownerTypeCode(1054)).toBe('T41e')
  })
})
