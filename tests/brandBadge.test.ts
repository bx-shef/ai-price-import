import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { BRAND_BADGE, BRAND_BADGE_CLASSES, brandBadgeHtml } from '../app/config/brandBadge'

const resolveSync = (id: string, from: string) => `file://${createRequire(from).resolve(id)}`

// The badge exists twice by necessity (#329): a Tailwind-styled Vue component on the landing, and
// inline CSS on the share card, which is rendered by headless Chromium with no Vue and no Tailwind.
// These tests are what keeps the copy honest — the whole point of extracting BrandBadge in #325 was
// «one mark, one place», and a silently drifting second copy would undo it.
describe('токены бейджа не разъезжаются с BrandBadge.vue', () => {
  const vue = readFileSync(new URL('../app/components/BrandBadge.vue', import.meta.url), 'utf8')

  it('каждый класс, который описывает модуль, реально стоит в компоненте', () => {
    for (const cls of BRAND_BADGE_CLASSES) {
      expect(vue, `класс ${cls} исчез из BrandBadge.vue — токены в brandBadge.ts стали враньём`).toContain(cls)
    }
  })

  // Расшифровка палитры пришита не к литералам «как помню», а к САМОЙ теме Tailwind: v4 держит
  // палитру в oklch, и v3-хексы (#22d3ee/#67e8f9) — заметно менее насыщенный цвет. Так карточка не
  // разъедется с лендингом и при будущем обновлении палитры: тест прочитает новое значение.
  const theme = readFileSync(
    new URL(resolveSync('tailwindcss/theme.css', import.meta.url)), 'utf8'
  )
  const themeColor = (name: string) => theme.match(new RegExp(`--color-${name}:\\s*([^;]+);`))?.[1]?.trim()

  it('цвета берутся из палитры установленного Tailwind, а не из памяти', () => {
    const cyan400 = themeColor('cyan-400')
    const cyan300 = themeColor('cyan-300')
    expect(cyan400, 'палитра Tailwind не прочиталась — тест перестал что-либо доказывать').toBeTruthy()
    expect(BRAND_BADGE.borderColor).toBe(`color-mix(in oklab, ${cyan400} 40%, transparent)`)
    expect(BRAND_BADGE.background).toBe(`color-mix(in oklab, ${cyan400} 10%, transparent)`)
    expect(BRAND_BADGE.brandColor).toBe(cyan300)
  })

  it('остальные токены соответствуют классам', () => {
    expect(BRAND_BADGE.captionColor).toBe('rgba(255,255,255,0.7)')
    expect(BRAND_BADGE.captionTrackingEm).toBe(0.14)
    expect(BRAND_BADGE.brandWeight).toBe(700) // font-bold
    expect(BRAND_BADGE.captionWeight).toBe(600) // font-semibold
  })
})

describe('brandBadgeHtml', () => {
  it('рисует бренд и подпись, геометрию масштабирует, цвета — нет', () => {
    const html = brandBadgeHtml('Bitrix24', 'Приложение', 2)
    expect(html).toContain('Bitrix24')
    expect(html).toContain('Приложение')
    expect(html).toContain('font-size:28px') // 14 × 2
    expect(html).toContain('font-size:20px') // 10 × 2
    expect(html).toContain('border-radius:12px') // 6 × 2
    expect(html).toContain('padding:12px 24px') // 6/12 × 2
    expect(html).toContain('gap:16px') // 8 × 2
    // Начертания рисуются в разметке — без этих проверок токен веса можно было поменять молча.
    expect(html).toContain('font-weight:700')
    expect(html).toContain('font-weight:600')
    expect(html).toContain(BRAND_BADGE.brandColor) // цвет от масштаба не зависит
  })
  it('масштаб 1 — размеры как на лендинге', () => {
    const html = brandBadgeHtml('Bitrix24', 'Приложение')
    expect(html).toContain('font-size:14px')
    expect(html).toContain('padding:6px 12px')
  })
})
