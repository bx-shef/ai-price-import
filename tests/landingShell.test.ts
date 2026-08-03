import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  CONTRAST_MIN_LARGE,
  CONTRAST_MIN_TEXT,
  SHELL_BG_CLASS,
  SHELL_BG_HEX,
  SHELL_BG_MOBILE_NAV_CLASS,
  SHELL_BG_STICKY_CLASS,
  SHELL_CLASS,
  SHELL_COLORS,
  SHELL_VARS
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

// Палитра берётся из ОТГРУЖАЕМОЙ темы — из палитры b24ui, а не из `tailwindcss/theme.css`.
// Первая версия читала стоковую тему Tailwind, и это делало весь расчёт декоративным: b24ui
// переопределяет палитру целиком (стоковый `slate-500` даёт к нашему фону 4.33, отгружаемый
// `#93a0b4` — 7.79), то есть числа в тесте описывали цвета, которых на странице нет. Тот же приём,
// что в `tests/brandBadge.test.ts`: значение читается там, откуда его берёт сборка.
// Через объявленный в `exports` подпуть `./runtime/*`, а не через `node_modules/…` руками: при
// pnpm-раскладке рукописный путь ведёт не туда, куда смотрит сборка.
const PALETTE = readFileSync(
  createRequire(import.meta.url).resolve('@bitrix24/b24ui-nuxt/runtime/air-design-tokens/tw-style/colors.css'),
  'utf8'
)
const themeColor = (name: string) => PALETTE.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{3,8})`, 'i'))?.[1]?.trim()

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = Number.parseInt(h, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Относительная яркость (WCAG 2.x). Вход — гамма-кодированный sRGB. */
function luminance(rgb: [number, number, number]): number {
  const lin = rgb.map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!
}

function contrast(fgName: string): number {
  const hex = themeColor(fgName)
  if (!hex) throw new Error(`цвета ${fgName} нет в отгружаемой палитре`)
  const fg = luminance(hexToRgb(hex))
  const bg = luminance(hexToRgb(SHELL_BG_HEX))
  const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg]
  return (hi! + 0.05) / (lo! + 0.05)
}

describe('#368: оболочка публичных страниц читается', () => {
  it('палитра действительно прочитана — иначе гард проходит ни на чём', () => {
    // Без этой проверки опечатка в имени цвета или смена формата темы дала бы «зелёный» тест,
    // который ничего не считает.
    for (const name of Object.values(SHELL_COLORS)) {
      expect(themeColor(name), `цвет ${name}`).toMatch(/^#[0-9a-f]{6}$/i)
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

  it('цвета из карты реально доезжают до разметки', () => {
    // Выжившая мутация из разбора: все цвета в компоненте переписаны на непроходящие — девять
    // тестов зелены, потому что гард считал контраст константы, которую компонент не читал.
    // Теперь компонент обязан брать цвета ТОЛЬКО через переменные `--legal-*`.
    const doc = read('app/components/LegalDocument.vue')
    for (const role of Object.keys(SHELL_COLORS)) {
      if (role === 'text') continue // основной текст едет классом `SHELL_CLASS`, не переменной
      expect(doc, `роль ${role} не подключена`).toContain(`var(--legal-${role})`)
    }
    // И ни одного цвета мимо карты: прямой `var(--color-…)`/`text-slate-…` снова сделал бы карту
    // декоративной.
    expect(doc, 'цвет мимо карты').not.toMatch(/var\(--color-/)
    expect(doc, 'цвет мимо карты').not.toMatch(/text-(slate|cyan)-\d/)
    for (const [key, value] of Object.entries(SHELL_VARS)) {
      expect(value, key).toBe(`var(--color-${SHELL_COLORS[key.replace('--legal-', '') as keyof typeof SHELL_COLORS]})`)
    }
  })

  it('хекс и класс фона не разъезжаются', () => {
    // Оба написаны литералами (иначе Tailwind не увидит класс-кандидат) — значит связь надо
    // сторожить: сменили класс, а контраст продолжает считаться к старому фону.
    for (const cls of [SHELL_BG_CLASS, SHELL_BG_STICKY_CLASS, SHELL_BG_MOBILE_NAV_CLASS]) {
      expect(cls, cls).toContain(SHELL_BG_HEX)
    }
    expect(SHELL_CLASS).toContain(`text-${SHELL_COLORS.text}`)
  })

  it('хекс фона не написан больше нигде в app/', () => {
    // Утечка из разбора: шапка лендинга держала свои копии `bg-[#05010f]/85` и `/95`, и смена фона
    // оставила бы её прежней — видимый шов при прокрутке, при зелёных тестах.
    const strays = execFileSync('git', ['grep', '-l', SHELL_BG_HEX, '--', 'app/'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).filter(f => f !== 'app/config/landingShell.ts')
    expect(strays, 'копия фона мимо общего источника').toEqual([])
  })

  it('пара классов неразделима по построению', () => {
    // Гард на сам источник: `SHELL_CLASS` обязан нести и фон, и цвет текста. Разложи его на две
    // константы «для гибкости» — и половину снова можно будет взять без второй.
    expect(SHELL_CLASS).toContain(SHELL_BG_CLASS)
    expect(SHELL_CLASS).toMatch(/text-/)
  })
})
