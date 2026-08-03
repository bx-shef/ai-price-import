import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CONTRAST_MIN_LARGE,
  CONTRAST_MIN_TEXT,
  SHELL_BG_CLASS,
  SHELL_BG_HEX,
  SHELL_CLASS,
  SHELL_COLORS
} from '../app/config/landingShell'

// #368. `/privacy` и `/eula` открывались и отдавали 200, но текст был тёмно-серым на почти чёрном:
// оболочку лендинга скопировали НАПОЛОВИНУ — фон через `bodyAttrs` взяли, цвет текста (он живёт на
// корневом элементе разметки, а не в `useHead`) нет. Ни один тест этого не видел и не мог: страница
// собирается, отдаёт 200, весь текст присутствует в HTML. Не видно его только глазами.
//
// Отсюда два разных гарда ниже:
//   1. СТРУКТУРНЫЙ — кто берёт фон, обязан взять и передний план. Бьёт по исходникам, потому что
//      именно копирование половины и было дефектом;
//   2. ЧИСЛЕННЫЙ — контраст считается по WCAG из настоящих значений палитры. Он ловит то, чего
//      структурный не увидит: цвет на месте, но нечитаемый.

const ROOT = new URL('../', import.meta.url).pathname
const read = (p: string) => readFileSync(ROOT + p, 'utf8')

// Палитра берётся из САМОЙ темы Tailwind, а не из хексов «как помню»: v4 держит цвета в oklch, и
// v3-хексы заметно отличаются по насыщенности. Тот же приём, что в `tests/brandBadge.test.ts`.
const resolveSync = (id: string, from: string) => `file://${createRequire(from).resolve(id)}`
const THEME = readFileSync(new URL(resolveSync('tailwindcss/theme.css', import.meta.url)), 'utf8')
const themeColor = (name: string) => THEME.match(new RegExp(`--color-${name}:\\s*([^;]+);`))?.[1]?.trim()

/** oklch(L C H) → sRGB. Достаточно для расчёта яркости; палитра Tailwind v4 записана именно так. */
function oklchToRgb(css: string): [number, number, number] | null {
  const m = css.match(/oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/)
  if (!m) return null
  const L = m[1]!.endsWith('%') ? Number.parseFloat(m[1]!) / 100 : Number.parseFloat(m[1]!)
  const C = Number.parseFloat(m[2]!)
  const h = (Number.parseFloat(m[3]!) * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_
  ]
  return lin.map(v => Math.min(1, Math.max(0, v))) as [number, number, number]
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = Number.parseInt(h, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Относительная яркость (WCAG 2.x). Вход — линейный sRGB для oklch, гамма-кодированный для hex. */
function luminance(rgb: [number, number, number], gammaEncoded: boolean): number {
  const lin = rgb.map(v => (gammaEncoded ? (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) : v))
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!
}

function contrast(fgName: string): number {
  const css = themeColor(fgName)
  if (!css) throw new Error(`цвета ${fgName} нет в теме Tailwind`)
  const rgb = oklchToRgb(css)
  if (!rgb) throw new Error(`не разобрал цвет ${fgName}: ${css}`)
  const fg = luminance(rgb, false)
  const bg = luminance(hexToRgb(SHELL_BG_HEX), true)
  const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg]
  return (hi! + 0.05) / (lo! + 0.05)
}

describe('#368: оболочка публичных страниц читается', () => {
  it('палитра действительно прочитана — иначе гард проходит ни на чём', () => {
    // Без этой проверки опечатка в имени цвета или смена формата темы дала бы «зелёный» тест,
    // который ничего не считает.
    for (const name of Object.values(SHELL_COLORS)) {
      expect(themeColor(name), `цвет ${name}`).toBeTruthy()
      expect(oklchToRgb(themeColor(name)!), `разбор ${name}`).toBeTruthy()
    }
  })

  it('основной текст документа проходит WCAG AA', () => {
    expect(contrast(SHELL_COLORS.text)).toBeGreaterThanOrEqual(CONTRAST_MIN_TEXT)
  })

  it('второстепенный текст и цитаты тоже проходят AA', () => {
    // Строка издателя и цитаты — не украшение: в политике цитатой оформлены оговорки, а строка
    // издателя это реквизиты, ради которых страницу и открывают.
    expect(contrast(SHELL_COLORS.muted)).toBeGreaterThanOrEqual(CONTRAST_MIN_TEXT)
    expect(contrast(SHELL_COLORS.quote)).toBeGreaterThanOrEqual(CONTRAST_MIN_TEXT)
  })

  it('ссылки различимы как текст', () => {
    expect(contrast(SHELL_COLORS.link)).toBeGreaterThanOrEqual(CONTRAST_MIN_TEXT)
  })

  it('рамки таблиц видны — планка 3:1, они не текст', () => {
    // Таблица в политике несущая: без видимых рамок она читается как слипшийся абзац.
    expect(contrast(SHELL_COLORS.border)).toBeGreaterThanOrEqual(CONTRAST_MIN_LARGE)
  })
})

describe('#368: фон и текст берутся вместе, а не порознь', () => {
  const SHELL_USERS = ['app/pages/index.vue', 'app/components/LegalDocument.vue']

  // ⚠ Строки `import` вырезаются ПЕРЕД поиском. Первая версия гарда искала имя по всему файлу и
  // находила его в импорте: мутация «убрать `SHELL_CLASS` из корневого элемента» проходила
  // незамеченной, то есть гард сторожил наличие импорта, а не применение — ровно ту половину, из-за
  // которой дефект и возник.
  const withoutImports = (src: string) => src.split('\n').filter(l => !/^\s*import\b/.test(l)).join('\n')

  it('обе публичные оболочки ПРИМЕНЯЮТ пару, а не только импортируют', () => {
    for (const f of SHELL_USERS) {
      const body = withoutImports(read(f))
      expect(body, `${f}: фон не из общего источника`).toContain('SHELL_BG_CLASS')
      expect(body, `${f}: передний план не навешан на разметку`).toMatch(/:class=[^\n]*SHELL_CLASS/)
    }
  })

  it('ни одна из них не пишет фон литералом мимо источника', () => {
    // Ровно так дефект и появился: литерал фона скопировали, а цвет текста — нет.
    for (const f of SHELL_USERS) {
      expect(read(f), `${f}: литерал фона в обход источника`).not.toMatch(/bg-\[#05010f\]/)
    }
  })

  it('в юридической странице не осталось токенов, которым здесь неоткуда взяться', () => {
    // `var(--ui-color-base-*)` — токены темы b24ui. У публичных страниц нет обёртки `B24App`
    // (в `app/layouts/` только `clear.vue`, и он для in-portal экранов), поэтому переменные не
    // разворачиваются и цвет остаётся дефолтным. Это и было причиной «чёрным по чёрному».
    expect(read('app/components/LegalDocument.vue')).not.toMatch(/--ui-color-base-/)
  })

  it('пара классов неразделима по построению', () => {
    // Гард на сам источник: `SHELL_CLASS` обязан нести и фон, и цвет текста. Разложи его на две
    // константы «для гибкости» — и половину снова можно будет взять без второй.
    expect(SHELL_CLASS).toContain(SHELL_BG_CLASS)
    expect(SHELL_CLASS).toMatch(/text-/)
  })
})
