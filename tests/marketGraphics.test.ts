import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — .mjs helper shared with scripts/make-og.mjs (plain JS by design, no types)
import { buildOgHtml } from '../scripts/lib/ogTemplate.mjs'
import { BRAND_BADGE } from '../app/config/brandBadge'
import { LANDING_HERO_NOTE, LANDING_MARKET_PROMO, LANDING_TITLE, LANDING_WHY_SUBTITLE } from '../app/utils/landing'

// `docs/market-graphics.md` is a hand-off brief: an outside designer paints from its numbers without
// ever opening this repository. That makes every value in it a COPY of something the code owns —
// the palette, the badge tokens, the cover's own title — and copies here fail in the worst possible
// way, silently and off-site.
//
// The failure mode is not hypothetical, it is #329 replayed: change the accent in the card template,
// `tests/ogStamp.test.ts` demands `pnpm og`, the PNG is rebuilt, CI turns green — and the brief keeps
// quoting the retired colour. Nothing in that loop reads the document.
//
// So this guard parses the DOCUMENT and compares it against the sources, exactly like
// `tests/hourlyRateHints.test.ts` does for the hourly-rate table, instead of introducing a third
// copy of the numbers here.
const DOC = readFileSync(new URL('../docs/market-graphics.md', import.meta.url).pathname, 'utf8')

/** §7's marketing palette table only.
 *
 * Scoped, for the same reason `hourlyRateHints` scopes its section: `#rrggbb` matches ANY hex, and
 * §0 legitimately carries the logo's own colours in prose. A doc-wide sweep would drag those in and
 * fail on nothing — and a guard that cries wolf gets weakened by the next person who trips over it. */
const PALETTE_SECTION = (() => {
  const from = DOC.indexOf('**Маркетинговая графика**')
  if (from < 0) return ''
  const to = DOC.indexOf('**Скриншоты интерфейса**', from)
  return DOC.slice(from, to < 0 ? undefined : to)
})()

const docHexes = () => [...new Set([...PALETTE_SECTION.matchAll(/`(#[0-9a-f]{6})`/gi)].map(m => m[1]!.toLowerCase()))]

/** `#6366f1` → `99,102,241` — the cover writes its glows as rgba(), not as hex. */
function rgbTriplet(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(',')
}

const LOGO = readFileSync(new URL('../public/favicon.svg', import.meta.url).pathname, 'utf8').toLowerCase()

describe('бриф дизайнеру не расходится с исходниками (docs/market-graphics.md)', () => {
  it('таблица палитры §7 разобралась — иначе гард молча проходит ни на чём', () => {
    expect(PALETTE_SECTION, 'не найден раздел «Маркетинговая графика» в §7').not.toBe('')
    expect(docHexes().length).toBeGreaterThanOrEqual(7)
  })

  it('каждый цвет из §7 действительно используется обложкой или логотипом', async () => {
    const card = (await buildOgHtml()).toLowerCase()
    const missing = docHexes().filter(hex =>
      !card.includes(hex) && !card.includes(rgbTriplet(hex)) && !LOGO.includes(hex))
    expect(
      missing,
      `Цвета из брифа больше нет ни в обложке, ни в логотипе: ${missing.join(', ')}. `
      + 'Поправили палитру в коде — поправьте §7 в docs/market-graphics.md, иначе дизайнер красит по устаревшей.'
    ).toEqual([])
  })

  it('токены бренд-плашки в §7 совпадают с BRAND_BADGE', () => {
    // Цвета плашки записаны в oklch (палитра Tailwind v4): hex-эквивалент v3 — заметно другой,
    // более тусклый оттенок, и именно на этом уже спотыкались (#329).
    for (const oklch of [BRAND_BADGE.brandColor, /* cyan-400 из рамки и фона */ 'oklch(78.9% 0.154 211.53)']) {
      expect(PALETTE_SECTION.includes(oklch) || DOC.includes(oklch), `в брифе нет ${oklch}`).toBe(true)
    }
    expect(PALETTE_SECTION).toContain(`${BRAND_BADGE.captionTrackingEm}`.replace('.', ','))
  })

  it('заголовок изображения №1 — точная цитата LANDING_TITLE', () => {
    // Единственная настоящая цитата лендинга в документе; остальные тексты карточки написаны
    // по мотивам и намеренно отличаются. Витрина и сайт обязаны звать продукт одинаково.
    expect(DOC).toContain(LANDING_TITLE)
  })
})

describe('пин известного расхождения: лендинг обещает бесплатное приложение (#387)', () => {
  // §9 брифа запрещает писать цену, ссылаясь на то, что лендинг ПОКА утверждает обратное. В день,
  // когда лендинг починят, это предупреждение начнёт описывать несуществующее противоречие — и
  // никто не покраснеет, потому что предупреждение живёт в markdown. Пин по образцу
  // `tests/markdownLite.test.ts`: незакрытая задача видима, а закрытие требует осознанно вычеркнуть
  // строку — здесь заодно и §9 брифа, и строку «Тариф» в docs/PROJECT_MAP.md.
  it('тексты лендинга про бесплатность ещё на месте — починили, вычеркните пин и правьте §9', () => {
    expect(LANDING_HERO_NOTE).toContain('Бесплатное')
    expect(LANDING_WHY_SUBTITLE).toContain('Бесплатное')
    expect(LANDING_MARKET_PROMO.text).toContain('бесплатное')
  })
})
