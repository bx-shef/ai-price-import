import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_ANNOUNCEMENT_CTA, MAX_ANNOUNCEMENT_DAYS, MAX_ANNOUNCEMENT_IMAGE_BYTES, MAX_ANNOUNCEMENT_TEXT, MAX_ANNOUNCEMENT_TITLE } from '../app/config/announcement'

/**
 * Где показывается объявление издателя и как его заводят (#473).
 *
 * ⚠ Структурные проверки, и это осознанный размен: смонтировать `/app` целиком нельзя без
 * фрейм-токена и портала, а консоль оператора — без сессии. Зато мутации, которые они ловят, — ровно
 * те, что случались: вернуть показ на пусковую страницу и снять подпись поля.
 */

const ROOT = new URL('..', import.meta.url).pathname
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')
/**
 * Комментарии вырезаем ПЕРЕД поиском: гард, краснеющий на объяснении дефекта, подталкивает удалить
 * объяснение, а не дефект. Тот же приём, что в гардах имени продукта и оболочки лендинга.
 *
 * ⚠ Режем ТОЛЬКО html-комментарии. Первая редакция резала заодно и `//`-строки — и съедала половину
 * строки на каждом `https://` в разметке, то есть молча ослабляла проверки: утверждение про подпись
 * кнопки не находило свой текст, потому что тот стоял после адреса. Гард, портящий собственный
 * вход, — это способ получить зелёный CI, а не проверку.
 */
const strip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '')

describe('#473 п.1/п.2: объявление живёт на РАБОЧЕМ экране', () => {
  const page = strip(read('app/pages/app.vue'))

  it('показывается только при рабочем состоянии экрана', () => {
    // ⚠ Прежде окно стояло ВНЕ условия и всплывало при любом состоянии — в том числе на пусковой
    // странице, которую через мгновение закрывает слайдер. А отметку «видел» ставит ЛЮБОЕ закрытие,
    // поэтому человек терял объявление, не дочитав: оно уходило вместе с лаунчером и на рабочем
    // экране уже не появлялось. Канал «сказать всем сразу» молча терял часть адресатов.
    expect(page).toMatch(/<AnnouncementDialog\s+v-if="screen === 'work'"/)
  })

  it('условие ОДНО на компьютер и мобильное приложение', () => {
    // В мобильном клиенте слайдера нет: `/app` там и есть главная. «Рабочий экран» — единственная
    // формулировка, верная на обоих; правка «показывать в слайдере» выключила бы телефон заодно.
    const at = page.indexOf('<AnnouncementDialog')
    const tag = page.slice(at, page.indexOf('/>', at))
    expect(tag, 'носитель не должен решаться на странице').not.toMatch(/isBitrixMobile|isPhone|sm:/)
  })
})

describe('#473 п.3: ширина окна признаком устройства не является', () => {
  const dialog = strip(read('app/components/AnnouncementDialog.vue'))

  it('решает useDevice, а медиазапрос лишь добавляет узкий браузер', () => {
    expect(dialog).toMatch(/const \{ isBitrixMobile \} = useDevice\(\)/)
    expect(dialog, 'ширина не должна решать одна').toMatch(/isBitrixMobile\.value \|\| isNarrow\.value/)
  })
})

describe('#473 п.5: у каждого поля есть НАЗВАНИЕ, а не только пример значения', () => {
  const ops = read('app/components/OpsAnnouncementCard.vue')

  // Поимённо: «проверить, что где-то есть label» проходило бы и когда половина полей его потеряла.
  const LABELLED = ['Заголовок', 'Текст объявления', 'Картинка', 'Ссылка кнопки', 'Подпись кнопки', 'Сколько дней показывать']
  for (const label of LABELLED) {
    it(`«${label}» подписано`, () => {
      expect(ops, `поле «${label}» осталось без названия`).toContain(`label="${label}"`)
    })
  }

  it('placeholder перестал быть подписью поля', () => {
    // Он исчезает, как только в поле что-то введено, — вместе с назначением поля. Хуже всех было
    // узкое поле срока: увидев в нём «14», догадаться, что это дни показа, нельзя.
    expect(ops).not.toMatch(/placeholder="Заголовок"/)
    expect(ops).not.toMatch(/placeholder="Текст объявления"/)
    expect(ops).not.toMatch(/placeholder="Дней"/)
  })

  it('пределы и правила названы ДО отправки, а не в тексте отказа', () => {
    const strippedOps = strip(ops)
    expect(strippedOps, 'предел срока').toContain('MAX_ANNOUNCEMENT_DAYS')
    expect(strippedOps, 'предел картинки').toContain('MAX_ANNOUNCEMENT_IMAGE_BYTES')
    expect(strippedOps, 'форматы картинки').toMatch(/png, jpeg, webp/)
    expect(strippedOps, 'без подписи кнопки не опубликуется').toMatch(/подписи кнопки/)
    // Числа берём из конфига, а не переписываем в разметку: разъехавшись, форма обещала бы одно, а
    // сервер резал по другому.
    expect(MAX_ANNOUNCEMENT_TITLE).toBeGreaterThan(0)
    expect(MAX_ANNOUNCEMENT_TEXT).toBeGreaterThan(0)
    expect(MAX_ANNOUNCEMENT_CTA).toBeGreaterThan(0)
    expect(MAX_ANNOUNCEMENT_DAYS).toBeGreaterThan(0)
    expect(MAX_ANNOUNCEMENT_IMAGE_BYTES).toBeGreaterThan(0)
  })

  it('пределы в форме не переписаны числами', () => {
    // Литерал «600» в разметке разошёлся бы с конфигом молча.
    const fields = strip(ops)
    expect(fields).toMatch(/:maxlength="MAX_ANNOUNCEMENT_TITLE"/)
    expect(fields).toMatch(/:maxlength="MAX_ANNOUNCEMENT_TEXT"/)
    expect(fields).toMatch(/:maxlength="MAX_ANNOUNCEMENT_CTA"/)
  })
})

describe('#473 п.4/п.7: предпросмотр настоящий, работа — в панели', () => {
  const ops = strip(read('app/components/OpsAnnouncementCard.vue'))

  it('предпросмотр рисует САМ компонент объявления, а не свою карточку', () => {
    expect(ops).toMatch(/<AnnouncementDialog[\s\S]*?:preview="preview"/)
    // Прежний пересказ: заголовок, картинка и строка «Кнопка «…» → https://…».
    expect(ops, 'вернулся собственный рендер предпросмотра').not.toMatch(/Кнопка «\{\{/)
  })

  it('проверяются ОБА вида — окно и шторка', () => {
    // Оператор сидит за компьютером, а половина адресатов увидит шторку.
    expect(ops).toMatch(/previewAs = 'modal'/)
    expect(ops).toMatch(/previewAs = 'sheet'/)
  })

  it('форма живёт в панели, на странице — состояние и вход', () => {
    expect(ops).toMatch(/<B24Slideover/)
    expect(ops, 'кнопка входа в панель').toMatch(/label="Объявление"/)
  })
})
