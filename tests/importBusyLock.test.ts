import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'
import type { ElementNode, TemplateChildNode } from '@vue/compiler-core'

// #475. Пока идёт пачка, остальной экран обязан быть заблокирован — чтобы оператор не почистил
// историю, не обнулил метрики и не открыл настройки посреди прогона.
//
// ⚠ Замок был сделан классом `pointer-events-none` на контейнере, и это НЕ блокировка: он гасит
// только указатель, а кнопки внутри остаются в порядке обхода по Tab и срабатывают по Enter. То
// есть очистка списка, обнуление счётчиков и смена цели во время пачки выполнялись с клавиатуры —
// ровно те действия, ради запрета которых замок и ставили. А настройки открывались и обычной
// мышью: шестерёнка не была заблокирована ВООБЩЕ — она живёт в слоте `#right` навбара каркаса, то
// есть вне всех блоков, которые гасились по `busy`.
//
// ⚠ ЭТОТ ГАРД ДВАЖДЫ ОБЕЩАЛ БОЛЬШЕ, ЧЕМ ПРОВЕРЯЛ, и оба раза его ловило ревью, а не он сам.
// Первая редакция знала две кнопки из девяти и утверждала, что `pointer-events-none` больше нигде
// не замок (оставалось три вхождения, два поверх живых кнопок). Вторая знала семь и объявляла
// список «исчерпывающим по построению» — мимо прошли две «Отмена». Причина одна: список вёлся
// РУКАМИ, а руками ведётся то, что забывают.
//
// Поэтому теперь гард НЕ ЧИТАЕТ СТРОКИ, а разбирает шаблон: находит поддеревья, гасимые по `busy`,
// обходит их целиком и требует блокировки у КАЖДОГО интерактивного узла. Забытая кнопка краснеет
// сама, без правки списка. Тем же приёмом ревью и нашло, что элементов девять, а не семь.

const PAGE = new URL('../app/pages/app.vue', import.meta.url).pathname
const src = readFileSync(PAGE, 'utf8')
const template = parse(src).descriptor.template
if (!template) throw new Error('в app/pages/app.vue нет шаблона')

const isElement = (n: TemplateChildNode): n is ElementNode => n.type === 1

/**
 * Directive/attr as source text, e.g. `:disabled` → `busy || loading`. `null` when absent.
 *
 * ⚠ Собираем ВСЕ совпадения, а не первое: у одного узла законно есть и статический `class`, и
 * `:class`. Возврат первого давал статику, выражение с `busy` терялось, и обход находил ноль
 * блоков — то есть гард молча проверял пустое множество. Ровно тот исход, от которого страхует
 * первый тест ниже.
 */
function binding(node: ElementNode, name: string): string | null {
  const found: string[] = []
  for (const p of node.props) {
    if (p.type === 6 && p.name === name) found.push(p.value?.content ?? '')
    if (p.type === 7 && p.arg?.type === 4 && p.arg.content === name) {
      found.push(p.exp?.type === 4 ? p.exp.content : '')
    }
  }
  return found.length ? found.join(' ') : null
}

/** Собрать узлы поддерева, включая корень. */
function walk(node: TemplateChildNode, out: ElementNode[] = []): ElementNode[] {
  if (isElement(node)) {
    out.push(node)
    for (const c of node.children) walk(c, out)
  } else if ('children' in node && Array.isArray(node.children)) {
    for (const c of node.children as TemplateChildNode[]) walk(c, out)
  }
  return out
}

const all = template.ast ? walk(template.ast as unknown as TemplateChildNode) : []

/** Узлы, чей `:class` гасится по `busy` — то есть «блоки, выключенные на время пачки». */
const busyBlocks = all.filter(n => (binding(n, 'class') ?? '').includes('busy ?'))

const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'B24Button', 'B24Select', 'B24Input', 'B24Checkbox'])
const isInteractive = (n: ElementNode) => INTERACTIVE_TAGS.has(n.tag) || binding(n, 'click') !== null

/**
 * Осознанные исключения — действия, доступные и во время пачки.
 *
 * ⚠ Список «что МОЖНО», а не «что нельзя»: он короткий, каждая строка — решение, и забыть его
 * нельзя по построению. Забудешь добавить сюда новое исключение — тест покраснеет на настоящей
 * кнопке; забыть же ЗАПРЕТИТЬ новое действие теперь невозможно, обход находит его сам.
 */
const ALLOWED: Array<{ text: string, why: string }> = [
  {
    text: 'Отмена',
    why: 'закрывает подтверждение и ничего не разрушает; заблокированная, она оставляла бы вопрос '
      + '«Убрать завершённые строки?» висеть на экране весь прогон, и снять его было бы нечем'
  }
]

/** Текст-подпись кнопки: `label="…"` у b24ui либо текстовый ребёнок. */
function label(n: ElementNode): string {
  const l = binding(n, 'label')
  if (l) return l
  const text = n.children.find(c => c.type === 2)
  return text && text.type === 2 ? text.content.trim() : ''
}

describe('#475: блокировка экрана на время пачки — настоящая, а не косметическая', () => {
  it('гасимые по busy блоки вообще найдены', () => {
    // Иначе весь набор ниже прошёл бы на пустом множестве — классический зелёный ни о чём.
    expect(busyBlocks.length).toBeGreaterThanOrEqual(3)
  })

  it('КАЖДОЕ действие внутри них выключено, кроме осознанных исключений', () => {
    const bad: string[] = []
    for (const block of busyBlocks) {
      for (const node of walk(block)) {
        if (!isInteractive(node)) continue
        const name = label(node) || node.tag
        if (ALLOWED.some(a => name.includes(a.text))) continue
        const dis = binding(node, 'disabled')
        if (dis === null || !dis.includes('busy')) bad.push(`${name} (<${node.tag}>) → :disabled=${dis ?? 'нет'}`)
      }
    }
    expect(bad, `не выключены во время пачки:\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('шестерёнка настроек выключена, хотя живёт ВНЕ этих блоков', () => {
    // Она в слоте `#right` навбара каркаса — обход выше её не увидит, поэтому проверяется отдельно.
    // Ровно из-за этого она и не была закрыта вовсе: замок стоял на блоках, а она не в блоке.
    const gear = all.find(n => binding(n, 'icon') === 'SettingsIcon')
    expect(gear, 'кнопка настроек не найдена').toBeTruthy()
    expect(binding(gear!, 'disabled')).toContain('busy')
  })

  it('у шестерёнки обе ветки подписи — константы', () => {
    // Разъехавшись, `aria-label` и `title` озвучивали бы программе чтения одно, а мыши показывали
    // другое. Первая правка свела только заблокированную ветку — незаблокированная осталась двумя
    // литералами, то есть могла разъехаться ровно тем же способом.
    const gear = all.find(n => binding(n, 'icon') === 'SettingsIcon')!
    for (const attr of ['aria-label', 'title']) {
      expect(binding(gear, attr)).toBe('busy ? SETTINGS_BLOCKED_LABEL : SETTINGS_LABEL')
    }
  })

  it('замок НЕ держится на pointer-events-none', () => {
    // Негативная половина: без неё дырявый замок можно было бы вернуть, не уронив ничего.
    // ⚠ Проверяется ИМЕННО связка «гасим по busy указателем», а не сам класс: на лендинге он
    // декоративный, а в `ImportStaging` висит на дропзоне, где настоящий замок — `:disabled` у
    // `<input type=file>` и ранний выход в `onDrop`.
    expect(src).not.toMatch(/busy \?[^"]*pointer-events-none/)
  })

  it('причина сказана ВИДИМОЙ строкой, а не только подсказкой у кнопки', () => {
    // ⚠ `title` на выключенной кнопке не всплывает: Chromium не доставляет отключённым контролам
    // событий указателя, а из обхода по Tab она уже выпала — ни мышь, ни клавиатура причину не
    // получили бы. На телефоне подсказок нет вовсе, и баннер там ЕДИНСТВЕННЫЙ носитель.
    // ⚠ Текст сформулирован по принципу, а не перечнем: на телефоне шестерёнки и «Подробных
    // метрик» нет вовсе (`v-if="!isBitrixMobile"`), и перечень обещал бы там несуществующее.
    const staging = readFileSync(new URL('../app/components/ImportStaging.vue', import.meta.url).pathname, 'utf8')
    expect(staging).toContain('Пока идёт импорт остальные действия на экране выключены')
  })

  it('контент внутри блоков НЕ гасится прозрачностью', () => {
    // ⚠ Регрессия, найденная ревью: `opacity-60` на контейнере перемножался с `disabled:opacity-30`
    // у кнопок b24ui — композит 0,18, контраст 1,2:1. Но хуже другое: под тем же димом сидел НЕ
    // выключенный, информационный текст — счётчики и цифры экономии (1,97:1), которые во время
    // прогона как раз и хотят читать. Выключенность показывают сами контролы, а не поле вокруг них.
    for (const block of busyBlocks) {
      expect(binding(block, 'class') ?? '').not.toMatch(/opacity-\d/)
    }
  })
})
