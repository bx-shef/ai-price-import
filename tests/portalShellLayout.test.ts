import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PORTAL_CONTENT_X, PORTAL_NAVBAR_X } from '../app/config/portalShell'

/**
 * Оболочка in-portal экранов: подложка, выравнивание шапки с контентом, раскладка в две колонки.
 *
 * Владелец сравнил наш экран со штатным приложением портала и назвал пять вещей: странный
 * заголовок, «блоки вылезли за край», не видно метрик, не видно подвала и слишком узкая колонка.
 * Четыре из пяти оказались следствиями двух решений в разметке, и оба тихо возвращаются при любом
 * причёсывании классов — поэтому гард структурный, по шаблонам SFC.
 *
 * ⚠ Первая редакция этого файла была ХУЖЕ, чем ничего, и урок стоит записать. Она проверяла, что у
 * навбара ОБЪЯВЛЕН проп с отступом, — и была зелёной ровно в тот момент, когда отступ не
 * применялся: `px-*` не вытесняет родные `ps-*`/`pe-*` (у `tailwind-merge` нет такого правила
 * конфликта), а в CSS длинные свойства идут после короткого. Гард подтверждал НАМЕРЕНИЕ, а не
 * результат. Теперь несущая проверка — сверка с ОТГРУЖАЕМОЙ темой b24ui: наш перекрывающий класс
 * обязан объявлять утилиту той же формы и на каждом брейкпоинте, который использует сам компонент.
 * Обновится b24ui, добавит `xl:ps-8` — тест покраснеет и скажет, что выравнивание молча уехало.
 */

const ROOT = new URL('..', import.meta.url).pathname
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')
/** Комментарии вырезаем ПЕРЕД поиском: гард, краснеющий на объяснении дефекта, подталкивает удалить
 *  объяснение, а не дефект. Тот же приём в гардах имени продукта и оболочки лендинга. */
const template = (p: string) => {
  const src = read(p)
  const from = src.indexOf('<template>')
  return src.slice(from === -1 ? 0 : from).replace(/<!--[\s\S]*?-->/g, '')
}

/** Экраны, живущие внутри портала на общем каркасе. Список ПОИМЁННЫЙ — «проверить, что где-то есть
 *  выравнивание» прошло бы и когда его потеряла половина страниц. */
const PORTAL_SCREENS = ['app/pages/app.vue', 'app/pages/settings.vue', 'app/pages/metrics.vue']

/** Родные классы корня `B24DashboardNavbar` — читаются из САМОЙ отгружаемой темы, а не переписаны
 *  сюда руками: переписанная копия устаревает молча, и именно молчание тут дороже всего. */
function navbarRootClassesFromB24ui(): string {
  const dir = resolve(ROOT, 'node_modules/@bitrix24/b24ui-nuxt/dist/shared')
  const files = readdirSync(dir).filter(f => f.endsWith('.mjs'))
  for (const f of files) {
    const src = readFileSync(resolve(dir, f), 'utf8')
    const at = src.indexOf('const dashboardNavbar')
    if (at === -1) continue
    const root = /root:\s*"([^"]+)"/.exec(src.slice(at, at + 600))
    if (root?.[1]) return root[1]
  }
  throw new Error('тема dashboardNavbar не найдена в отгружаемом b24ui — гард сторожит пустоту')
}

/** Разбор утилиты горизонтального отступа в пары «брейкпоинт + сторона». `px`/`p` кроют обе. */
function inlinePaddingKeys(classes: string): Set<string> {
  const keys = new Set<string>()
  for (const token of classes.split(/\s+/).filter(Boolean)) {
    const m = /^(?:([a-z0-9]+):)?(p|px|ps|pe)-/.exec(token)
    if (!m) continue
    const variant = m[1] ?? 'base'
    const sides = m[2] === 'ps' ? ['start'] : m[2] === 'pe' ? ['end'] : ['start', 'end']
    for (const side of sides) keys.add(`${variant}:${side}`)
  }
  return keys
}

describe('оболочка in-portal экранов', () => {
  it('подложка — цвет ТЕМЫ, а не цвет карточки', () => {
    // `--ui-color-bg-content-primary` — поверхность карточки (в светлой теме #fff). Покрашенная им
    // оболочка делала белым весь экран, и карточки сливались с фоном в одно полотно: границы
    // читались только по тонкой рамке. Нужен фон, которым портал красит свои страницы.
    const layout = read('app/layouts/clear.vue')
    expect(layout).toMatch(/bg-\(--air-theme-bg-color\)/)
    expect(layout).not.toMatch(/bg-\(--ui-color-bg-content-primary\)/)
  })

  it('перекрытие отступа навбара РЕАЛЬНО вытесняет родное, а не встаёт рядом', () => {
    // Несущая проверка файла. `tailwind-merge` снимает родной класс, только если наш — той же формы
    // (логические `ps`/`pe` против `ps`/`pe`) и на том же брейкпоинте; иначе оба доезжают до
    // браузера, и там побеждает не наш. Проверяем это против ОТГРУЖАЕМОЙ темы, а не против памяти.
    const native = inlinePaddingKeys(navbarRootClassesFromB24ui())
    const ours = inlinePaddingKeys(PORTAL_NAVBAR_X)
    expect(native.size, 'у навбара пропали свои отступы — сверять стало не с чем').toBeGreaterThan(0)
    for (const key of native) {
      expect(ours, `родной отступ навбара «${key}» ничем не перекрыт — на этой ширине шапка разъедется с контентом`).toContain(key)
    }
  })

  it('навбару задаются ЛОГИЧЕСКИЕ утилиты, а не `px-*`', () => {
    // Отдельной проверкой, потому что ошибка выглядит безобидно: `px-4 sm:px-6` читается как то же
    // самое, а конфликта с `ps`/`pe` у него нет вовсе.
    expect(PORTAL_NAVBAR_X).toMatch(/\bps-/)
    expect(PORTAL_NAVBAR_X).toMatch(/\bpe-/)
    expect(PORTAL_NAVBAR_X, '`px-*` не вытесняет `ps-*`/`pe-*` — это и был дефект').not.toMatch(/\bpx-/)
  })

  for (const page of PORTAL_SCREENS) {
    it(`${page}: колонка контента не капается по ширине`, () => {
      // 720-й слайдер от этого не изменился (720 − 48 отступов = те же 672 px, из которых ширина
      // слайдера и выведена). Кеп бил по ШИРОКОМУ окну: узкий столбик посередине, поля по бокам и
      // заголовок навбара где-то слева от него.
      expect(template(page)).not.toMatch(/max-w-2xl/)
    })

    it(`${page}: шапка и колонка берут отступ из ОДНОГО источника`, () => {
      // Пока это были литералы в трёх шаблонах, четвёртый экран набрали бы руками и разошлись бы
      // молча. Проверяем именно использование констант, а не совпадение строк.
      const t = template(page)
      expect(t, 'навбар обязан брать отступ из PORTAL_NAVBAR_X').toMatch(/<B24DashboardNavbar[\s\S]{0,400}?PORTAL_NAVBAR_X/)
      expect(t, 'колонка контента обязана брать отступ из PORTAL_CONTENT_X').toMatch(/PORTAL_CONTENT_X/)
    })
  }

  it('пара отступов согласована по величине', () => {
    // Шапка и колонка обязаны давать ОДИН отступ на каждом брейкпоинте. Числа сверяем прямо: это
    // единственное, что глазами на скриншоте не видно — 8 px расхождения читаются как «случайно».
    const sizeByVariant = (classes: string) => {
      const out = new Map<string, string>()
      for (const token of classes.split(/\s+/).filter(Boolean)) {
        const m = /^(?:([a-z0-9]+):)?(?:p|px|ps|pe)-(.+)$/.exec(token)
        if (m) out.set(m[1] ?? 'base', m[2]!)
      }
      return out
    }
    const navbar = sizeByVariant(PORTAL_NAVBAR_X)
    const content = sizeByVariant(PORTAL_CONTENT_X)
    for (const [variant, size] of content) {
      expect(navbar.get(variant), `на «${variant}» колонка даёт ${size}, а шапка — ${navbar.get(variant) ?? 'ничего'}`).toBe(size)
    }
  })

  it('/app: две колонки включаются НЕ РАНЬШЕ lg', () => {
    // Слайдер приложения — 720 px, это НИЖЕ `lg` (1024). Порог ниже сделал бы боковую колонку в
    // слайдере, где ширины на неё нет: две колонки по ~330 px вместо одной читаемой.
    // ⚠ Проверяем ИМЕННО класс сетки-раскладки, а не весь шаблон. Первая редакция искала
    // `(?:sm|md):grid-cols-[23]` по всей странице и краснела на `sm:grid-cols-2` у плиток
    // экономии — совершенно законной внутренней сетке карточки. Гард, срабатывающий на постороннем
    // блоке, снимают целиком, а не уточняют.
    const t = template('app/pages/app.vue')
    const layoutGrid = /class="([^"]*\bgrid\b[^"]*lg:grid-cols-3[^"]*)"/.exec(t)
    expect(layoutGrid, 'сетка раскладки не найдена — гард сторожит несуществующий блок').not.toBeNull()
    expect(layoutGrid![1], 'колонки не должны включаться на sm/md').not.toMatch(/(?:sm|md):grid-cols-/)
  })

  it('/app: порядок в разметке — как на телефоне, местами колонки меняет только lg:order-*', () => {
    // Программа чтения и Tab идут по РАЗМЕТКЕ. Если поменять местами сами блоки, а не их `order`,
    // то на телефоне человек получит журнал раньше экономии — ровно ту раскладку, которую владелец
    // забраковал, и заметно это будет только с телефона.
    // ⚠ Проверяем ФИЗИЧЕСКИЙ порядок блоков, а не только наличие классов: перестановка блоков
    // ВМЕСТЕ с их `order` сохраняет обе подписи и прошла бы мимо проверки «класс на месте».
    const t = template('app/pages/app.vue')
    const aside = t.indexOf('<aside')
    const mainCol = t.search(/<div class="min-w-0 lg:order-1/)
    expect(aside, 'боковая колонка не найдена — гард сторожит несуществующий блок').toBeGreaterThan(-1)
    expect(mainCol, 'колонка журнала не найдена').toBeGreaterThan(-1)
    expect(aside, 'боковая колонка обязана идти в разметке ПЕРВОЙ — это порядок на телефоне').toBeLessThan(mainCol)
    expect(t).toMatch(/<aside[^>]*lg:order-2/)
  })

  it('/app: метрики и баннер стоят ВЫШЕ журнала', () => {
    // Журнал — единственный неограниченно длинный блок на экране (страница по 50 записей). Всё, что
    // окажется под ним, человек не увидит: именно так пропали из виду карточка экономии и баннер
    // «работа на вашем сервере». Порядок — часть требования владельца, а не вкусовая раскладка.
    const t = template('app/pages/app.vue')
    const metrics = t.indexOf('Сэкономлено времени')
    const promo = t.indexOf('<SelfHostedPromo')
    const journal = t.indexOf('<ImportJournal')
    expect(metrics, 'карточка экономии не найдена — гард сторожит несуществующий блок').toBeGreaterThan(-1)
    expect(promo).toBeGreaterThan(-1)
    expect(journal).toBeGreaterThan(-1)
    expect(metrics, 'метрики обязаны идти до журнала').toBeLessThan(journal)
    expect(promo, 'баннер обязан идти до журнала').toBeLessThan(journal)
  })

  it('/app: у кнопки настроек подпись прячется по ширине, а имя остаётся всегда', () => {
    // Это ИМЕНОВАННОЕ исключение из правила проекта «скрывать условным рендером, а не по ширине»:
    // прячется подпись, а не действие. Исключение без гарда следующий агент «исправит» по общему
    // правилу — и либо вернёт обрезанный заголовок на узком экране, либо снимет `aria-label`,
    // оставив кнопку без имени для программы чтения.
    const t = template('app/pages/app.vue')
    const at = t.indexOf('Настройки</span>')
    expect(at, 'подписи кнопки настроек нет — гард сторожит несуществующую кнопку').toBeGreaterThan(-1)
    const window = t.slice(Math.max(0, at - 800), at + 200)
    expect(window, 'подпись обязана прятаться именно ниже sm').toMatch(/class="hidden sm:inline"/)
    expect(window, 'у кнопки обязано остаться голосовое имя').toMatch(/:aria-label="busy \?/)
  })
})
