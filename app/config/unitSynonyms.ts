// Built-in «как пишут в документе» → ОКЕИ code map: the fallback layer under the portal's own units
// dictionary. Without it a fresh portal has an empty dictionary, so every unit except «шт» silently
// became «шт» in CRM (the default code is 796) — wrong data in the card, not a cosmetic issue (#272).
//
// ОКЕИ/UNECE codes are international and identical for RU/BY/KZ, so ONE map serves all three
// countries — see docs/PROCESS.md §9. Matching is by DICTIONARY, never by symbol.
//
// DATA ONLY — the lookup itself lives in app/utils/units.ts.
//
// SCOPE RULE, deliberately narrow: this stays a CLOSED set of units that show up in ordinary
// invoices. Anything rarer belongs in the portal's own dictionary, where an administrator maps it to
// their own measure. Without this rule the file grows to hundreds of lines and «добавьте нашу
// единицу» replaces configuring the portal.
//
// Latin spellings are listed EXPLICITLY rather than derived by folding Latin↔Cyrillic look-alikes:
// a folding layer silently widens matching for every unit at once («t»→«т»→тонна) in a field nobody
// double-checks, and a listed spelling is greppable.

/** Spellings per ОКЕИ code, as they actually appear in invoices (ru/be/kk + Latin forms). */
export const RAW_UNIT_SYNONYMS: Record<number, string[]> = {
  796: ['шт', 'штука', 'штуки', 'штук', 'pcs', 'pc', 'ea', 'дана'], // Штука; каз. «дана»
  166: ['кг', 'килограмм', 'килограмма', 'килограммов', 'kg', 'кілаграм'], // Килограмм
  163: ['г', 'гр', 'грамм', 'грамма', 'граммов', 'g', 'gr'], // Грамм
  168: ['т', 'тн', 'тонна', 'тонны', 'тонн', 't', 'ton'], // Тонна
  112: ['л', 'литр', 'литра', 'литров', 'l', 'літр'], // Литр
  6: ['м', 'метр', 'метра', 'метров', 'пог.м', 'п.м', 'м.п', 'пм', 'мп', 'погонный метр', 'метр погонный', 'm'], // Метр
  55: ['м2', 'м²', 'кв.м', 'кв м', 'квадратный метр', 'квадратных метров', 'm2', 'sq.m'], // Квадратный метр
  113: ['м3', 'м³', 'куб.м', 'куб м', 'кубический метр', 'кубометр', 'm3'], // Кубический метр
  778: ['уп', 'упак', 'упаковка', 'упаковки', 'упаковок', 'pack', 'pkg'], // Упаковка
  736: ['рул', 'рулон', 'рулона', 'рулонов', 'roll'], // Рулон
  715: ['пар', 'пара', 'пары', 'pair'], // Пара
  657: ['изд', 'изделие', 'изделия', 'изделий'], // Изделие
  839: ['компл', 'комплект', 'комплекта', 'комплектов', 'к-т'], // Комплект (ОКЕИ 839)
  704: ['набор', 'набора', 'наборов', 'наб', 'set'] // Набор (ОКЕИ 704 — это НАБОР, не комплект)
}
