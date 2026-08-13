import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// #259. In-portal экраны переведены на каркас официального шаблона bitrix24/templates-dashboard.
// Гард структурный: рендер этих страниц под фреймом проверяется только вживую, а вот ФОРМУ каркаса
// (панель на каждой странице, нейтрализованная база, отсутствие самопала) можно и нужно держать
// тестом — прошлый частичный заход разошёлся с задуманным именно молча.
//
// ⚠ Семантика `:b24ui` — МЕРДЖ через tailwind-merge, а не замена слота: выживает всё, чему не
// нашлось конфликтующего класса той же группы. Поэтому гард требует ЯВНЫХ нейтрализаторов
// (`min-h-0`, `overflow-y-visible`, `gap-0`, `sm:p-0`, `inset-auto`, `overflow-visible`), а не
// просто отсутствия родных токенов в исходнике — родные живут в теме и в исходнике страниц их
// нет по построению, так что негативная проверка сама по себе была бы декоративной.

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

/**
 * Strip HTML and JS comments, collapse whitespace. Mutation review showed the raw source lets
 * three escapes through: tokens hidden in `<!-- -->` (the guard only cut `//`), double spaces
 * defeating literal regexes, and `min-h-screen` surviving in a comment after being cut from code.
 */
const strip = (src: string) => src
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .split('\n')
  .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  .join('\n')
  .replace(/\s+/g, ' ')

/** The full `:b24ui="{…}"` attribute of the page's dashboard panel — not a fixed-width window. */
const panelOverride = (src: string) => {
  const code = strip(src)
  const tag = code.slice(code.indexOf('<B24DashboardPanel'))
  const m = tag.match(/:b24ui="\{[^"]*\}"/)
  return m ? m[0] : ''
}

/** Content of `<template #header>` up to its own closing tag — a 700-char window walked past it. */
const headerBlock = (src: string) => {
  const code = strip(src)
  const start = code.indexOf('<template #header>')
  if (start < 0) return ''
  return code.slice(start, code.indexOf('</template>', start))
}

const PAGES = ['app/pages/app.vue', 'app/pages/settings.vue', 'app/pages/metrics.vue']

describe('#259: каркас шаблона на in-portal экранах', () => {
  it('каждая страница живёт в B24DashboardPanel с навбаром в шапке и контентом в теле', () => {
    for (const p of PAGES) {
      const code = strip(read(p))
      expect(code, `${p}: нет панели`).toContain('<B24DashboardPanel')
      expect(headerBlock(read(p)), `${p}: навбар не в шапке панели`).toContain('B24DashboardNavbar')
      expect(code, `${p}: контент не в теле панели`).toContain('<template #body>')
    }
  })

  it('база панели нейтрализована: без min-h-svh, без внутренней прокрутки, без двойного паддинга', () => {
    // В iframe портала высоту задаёт КОНТЕНТ. Родной root панели несёт `min-h-svh` — храповик
    // высоты (контент всегда ≥ фрейма, портал не может его уменьшить), родное тело — `flex-1
    // overflow-y-auto gap-4 sm:p-4`: вложенный скролл и паддинг, складывающийся с паддингом
    // страницы. Мердж-семантика требует снять каждый явным конфликтующим классом.
    for (const p of PAGES) {
      const o = panelOverride(read(p))
      expect(o, `${p}: панель без переопределения`).not.toBe('')
      expect(o, `${p}: min-h-svh не нейтрализован`).toMatch(/min-h-0/)
      expect(o, `${p}: прокрутка тела не нейтрализована`).toMatch(/overflow-y-visible/)
      expect(o, `${p}: gap тела не нейтрализован`).toMatch(/gap-0/)
      expect(o, `${p}: sm-паддинг тела не нейтрализован`).toMatch(/sm:p-0/)
      // И запрет самого механизма поломки, а не только токена min-h-svh (мутация M4).
      expect(o, `${p}: внутренняя прокрутка вернулась`).not.toMatch(/overflow-y-(auto|scroll)/)
      expect(o, `${p}`).not.toMatch(/min-h-svh/)
    }
  })

  it('layout несёт группу каркаса с нейтрализованной базой в обычном потоке', () => {
    const code = strip(read('app/layouts/clear.vue'))
    expect(code).toContain('B24DashboardGroup')
    // Родная база группы — `fixed inset-0 flex overflow-hidden`. Каждый класс снят парой:
    expect(code).toMatch(/:b24ui="\{ base:/)
    expect(code).toMatch(/relative/)
    expect(code).toMatch(/inset-auto/)
    // `overflow-visible`, не только `overflow-x-hidden`: x-hidden — другая группа tailwind-merge
    // и родной `overflow-hidden` НЕ снимает.
    expect(code).toMatch(/overflow-visible/)
    expect(code).toMatch(/min-h-screen/)
    // Колонка, не родной ряд: в строчном flex страницы без панели (/install, /login) становились
    // fit-content-элементами и теряли центрирование.
    expect(code).toMatch(/flex-col/)
    expect(code).not.toMatch(/fixed\s+inset-0/)
  })

  it('аккордеон настроек ушёл — все блоки видны, навигация в тулбаре', () => {
    const s = strip(read('app/pages/settings.vue'))
    expect(s).not.toContain('B24Accordion')
    expect(s).toContain('B24DashboardToolbar')
    expect(s).toContain('B24NavigationMenu')
    // Блоки-пары шаблона: тонированная шапка + тело со склеенными скруглениями (§1.3 issue).
    // ⚠ Проверяется ПАРА, а не конкретный оттенок: 12.08.2026 (#523) шапки переведены с акцентной
    // `tinted` на нейтральную `tinted-no-accent` — синим были покрашены все шапки разом, и акцент
    // перестал что-либо выделять. Требование «шапка тонирована и склеена с телом» не изменилось,
    // поэтому гард ослаблен ровно на оттенок; запрет на возврат акцента держит
    // `tests/portalSliderChrome.test.ts`.
    expect(s).toMatch(/variant="tinted[^"]*"[\s\S]{0,200}sm:rounded-t-3xl/)
    expect(s).toMatch(/sm:rounded-b-3xl/)
  })

  it('на /metrics не осталось ручных карточек div.border', () => {
    const m = strip(read('app/pages/metrics.vue'))
    expect(m).not.toMatch(/<div class="[^"]*\bborder\b[^"]*\brounded/)
    expect(m).not.toMatch(/<div class="[^"]*\brounded[^"]*\bborder\b/)
    expect(m).toContain('B24PageCard')
  })

  it('сайдбар и командную палитру шаблона НЕ тянем (§4 issue)', () => {
    // Мы живём в iframe, разделы открываются слайдером портала — навигация каркаса не нужна, а
    // сайдбар с ресайзом внутри слайдера конфликтовал бы с шириной окна.
    for (const p of [...PAGES, 'app/layouts/clear.vue']) {
      const src = read(p)
      expect(src, p).not.toContain('B24DashboardSidebar')
      expect(src, p).not.toContain('B24DashboardSearch')
    }
  })
})
