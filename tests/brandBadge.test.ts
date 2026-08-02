import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRAND_BADGE, BRAND_BADGE_CLASSES, brandBadgeHtml } from '../app/config/brandBadge'

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

  it('значения токенов соответствуют классам Tailwind (расшифровка палитры)', () => {
    // cyan-400 = #22d3ee, cyan-300 = #67e8f9 — если поменяют оттенок в компоненте, класс уедет и
    // упадёт тест выше; здесь фиксируем саму расшифровку, чтобы карточка красилась тем же цветом.
    expect(BRAND_BADGE.borderColor).toBe('rgba(34,211,238,0.4)')
    expect(BRAND_BADGE.background).toBe('rgba(34,211,238,0.1)')
    expect(BRAND_BADGE.brandColor).toBe('#67e8f9')
    expect(BRAND_BADGE.captionColor).toBe('rgba(255,255,255,0.7)')
    expect(BRAND_BADGE.captionTrackingEm).toBe(0.14)
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
    expect(html).toContain(BRAND_BADGE.brandColor) // цвет от масштаба не зависит
  })
  it('масштаб 1 — размеры как на лендинге', () => {
    const html = brandBadgeHtml('Bitrix24', 'Приложение')
    expect(html).toContain('font-size:14px')
    expect(html).toContain('padding:6px 12px')
  })
})
