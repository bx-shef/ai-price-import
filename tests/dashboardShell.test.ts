import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// #259. In-portal экраны переведены на каркас официального шаблона bitrix24/templates-dashboard.
// Гард структурный: рендер этих страниц под фреймом проверяется только вживую, а вот ФОРМУ каркаса
// (панель на каждой странице, переопределённая база, отсутствие самопала) можно и нужно держать
// тестом — прошлый частичный заход разошёлся с задуманным именно молча.

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const PAGES = ['app/pages/app.vue', 'app/pages/settings.vue', 'app/pages/metrics.vue']

describe('#259: каркас шаблона на in-portal экранах', () => {
  it('каждая страница живёт в B24DashboardPanel с навбаром в #header', () => {
    for (const p of PAGES) {
      const src = read(p)
      expect(src, `${p}: нет панели`).toContain('B24DashboardPanel')
      expect(src, `${p}: навбар не в шапке панели`).toMatch(/<template #header>[\s\S]{0,700}B24DashboardNavbar/)
      expect(src, `${p}: контент не в теле панели`).toContain('<template #body>')
    }
  })

  it('база панели переопределена — родная несёт min-h-svh и внутреннюю прокрутку', () => {
    // В iframe портала высоту задаёт КОНТЕНТ. Родное тело панели (`flex-1 overflow-y-auto`) внутри
    // фиксированной оболочки скроллит само себя — у нас это дало бы нулевую высоту потока и
    // недостижимый высокий контент. Ровно из-за этого прошлый заход отказался от оболочки целиком;
    // теперь она взята с переопределением, и это переопределение обязано стоять на каждой панели.
    for (const p of PAGES) {
      const src = read(p)
      const panel = src.slice(src.indexOf('<B24DashboardPanel'), src.indexOf('<B24DashboardPanel') + 400)
      expect(panel, `${p}: панель без переопределения базы`).toMatch(/:b24ui="\{[^}]*root:/)
      expect(panel, `${p}`).not.toMatch(/min-h-svh/)
    }
  })

  it('layout несёт группу каркаса с базой в обычном потоке', () => {
    const layout = read('app/layouts/clear.vue')
    expect(layout).toContain('B24DashboardGroup')
    // Родная база группы — `fixed inset-0 flex overflow-hidden`: обнуляет прокрутку страницы и
    // высоту потока, по которой Битрикс24 подбирает высоту iframe. Комментарии режем перед
    // проверкой: причина описана словами ровно этой фразой.
    const code = layout.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    expect(code).toMatch(/:b24ui="\{ base:/)
    expect(code).not.toMatch(/fixed inset-0/)
    expect(code).toMatch(/min-h-screen/)
  })

  it('аккордеон настроек ушёл — все блоки видны, навигация в тулбаре', () => {
    const s = read('app/pages/settings.vue')
    expect(s).not.toContain('B24Accordion')
    expect(s).toContain('B24DashboardToolbar')
    expect(s).toContain('B24NavigationMenu')
    // Блоки-пары шаблона: тонированная шапка + тело со склеенными скруглениями (§1.3 issue).
    expect(s).toMatch(/variant="tinted"[\s\S]{0,200}sm:rounded-t-3xl/)
    expect(s).toMatch(/sm:rounded-b-3xl/)
  })

  it('на /metrics не осталось ручных карточек div.border', () => {
    const m = read('app/pages/metrics.vue')
    expect(m).not.toMatch(/<div class="[^"]*rounded-lg border/)
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
