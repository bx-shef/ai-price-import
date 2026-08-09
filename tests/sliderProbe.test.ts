import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatProbeEntry, probeOutcome, type ProbeEntry } from '../app/utils/sliderProbe'

const root = resolve(import.meta.dirname, '..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

describe('журнал стенда слайдеров (#477)', () => {
  it('пока управление не вернулось — строка говорит «ждём…», а не число', () => {
    const e: ProbeEntry = { label: '11 открыть тест 2', startedMs: 1500, elapsedMs: null, result: 'выполняется' }
    const line = formatProbeEntry(e)
    expect(line).toContain('ждём…')
    // ⚠ Несущее утверждение: без промежуточного состояния резолв-на-закрытии неотличим от
    // мгновенного возврата. Поэтому «мс» в незавершённой строке быть НЕ должно.
    expect(line).not.toContain('мс')
    expect(line).toContain('1.50 с')
  })

  it('вернувшаяся строка печатает и момент клика, и длительность', () => {
    const e: ProbeEntry = { label: '12 закрыть', startedMs: 0, elapsedMs: 4200, result: 'true' }
    expect(formatProbeEntry(e)).toBe('[0.00 с] 12 закрыть: 4200 мс → true')
  })

  it('исход — класс, а не текст исключения', () => {
    expect(probeOutcome('что угодно', true)).toContain('ОТКАЗ')
    expect(probeOutcome(true, false)).toBe('true')
    expect(probeOutcome(false, false)).toContain('false')
    expect(probeOutcome(undefined, false)).toContain('undefined')
  })
})

describe('страницы стенда (#477)', () => {
  const pages = ['app/pages/slider-test-1.vue', 'app/pages/slider-test-2.vue']

  it('обе несут robots:noindex — стенд не должен попасть в выдачу', () => {
    for (const p of pages) expect(read(p)).toMatch(/name:\s*'robots',\s*content:\s*'noindex'/)
  })

  it('тест 2 закрывается ДВУМЯ разными путями — в этом весь смысл пары кнопок', () => {
    const page = read('app/pages/slider-test-2.vue')
    expect(page).toContain('closeSliderViaSdk()')
    expect(page).toContain('closeSlider()')
  })

  it('пока стенд ЖИВ — обязательство его убрать записано в карте проекта', () => {
    // ⚠ Стенд диагностический и виден каждому сотруднику каждого портала: если про него забыть,
    // служебная кнопка уедет клиентам вместе со сдачей в Маркет. Своего env-флага у стенда нет
    // (решение владельца — клиентов ещё нет), значит единственная страховка это запись в карте
    // проекта, и она обязана существовать РОВНО пока существуют файлы стенда. Снимая стенд, эту
    // проверку убирают тем же коммитом — тест краснеет и не даёт оставить уборку наполовину.
    const map = read('docs/PROJECT_MAP.md')
    expect(map).toContain('#477')
    expect(map).toMatch(/стенд убрать целиком|убрать стенд/)
  })

  it('вход на стенд не спрятан от мобильного приложения', () => {
    // ⚠ Половина вопроса — поведение слайдеров именно в мобильном приложении Битрикс24.
    // Кнопка входа, скрытая по `isBitrixMobile`, сделала бы стенд там недостижимым.
    const app = read('app/pages/app.vue')
    // Берём РАЗМЕТКУ блока стенда: от открывающего `<div` его рамки до кнопки входа.
    const markup = app.slice(app.indexOf('<div class="mt-6 rounded-lg border border-dashed'))
    const block = markup.slice(0, markup.indexOf('@click="openSliderProbe"'))
    expect(block).toBeTruthy()
    expect(block).not.toContain('isBitrixMobile')
    expect(block).not.toContain('v-if')
  })
})
