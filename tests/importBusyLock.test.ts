import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// #475. Пока идёт пачка, остальной экран обязан быть заблокирован — чтобы оператор не почистил
// историю, не убрал строку, не обнулил метрики и не открыл настройки посреди прогона.
//
// ⚠ Замок был сделан классом `pointer-events-none` на контейнере, и это НЕ блокировка: он гасит
// только указатель, а кнопки внутри остаются в порядке обхода по Tab и срабатывают по Enter. То
// есть все перечисленные действия во время пачки выполнялись с клавиатуры — ровно те, ради запрета
// которых замок и ставили.
//
// ⚠ Шестерёнка настроек не была заблокирована ВООБЩЕ: она живёт в слоте `#right` навбара каркаса,
// то есть вне всех блоков, которые гасятся по `busy`. И цена там выше: сохранение настроек
// рассылает всем сотрудникам событие «перечитайте настройки» (#443), а идущая пачка работает на
// тех, с которыми стартовала.
//
// ⚠ ПОЧЕМУ ЭТОТ ГАРД СТРУКТУРНЫЙ, а не поведенческий. Поведение проверяется там, где компонент
// монтируется по-настоящему: `tests/nuxt/targetPicker.nuxt.test.ts` (кнопки и списки цели выключены
// атрибутом) и `tests/nuxt/importStaging.nuxt.test.ts` (цель пачки не меняется после старта) —
// обе проверки прогнаны мутациями. Страница `app.vue` в наборе не монтируется нигде, и поднять её
// ради двух кнопок значило бы застабить полтора десятка композаблов, то есть проверять не её.
// Поэтому здесь сторожится СВЯЗЬ кнопки с `busy`, и сторожится по элементу, а не по вхождению
// строки в файл: `:disabled="busy"` где угодно в разметке прошло бы проверку «строка есть».

const PAGE = new URL('../app/pages/app.vue', import.meta.url).pathname
const src = readFileSync(PAGE, 'utf8')

/** Вырезать разметку одного элемента по опорной строке внутри него. */
function elementAround(marker: string): string {
  const at = src.indexOf(marker)
  expect(at, `опорная строка не найдена: ${marker}`).toBeGreaterThan(-1)
  const open = src.lastIndexOf('<', at)
  const close = src.indexOf('>', at)
  expect(close).toBeGreaterThan(open)
  return src.slice(open, close + 1)
}

describe('#475: блокировка экрана на время пачки — настоящая, а не косметическая', () => {
  it('шестерёнка настроек выключается на время импорта', () => {
    const gear = elementAround(':icon="SettingsIcon"')
    expect(gear).toContain(':disabled="busy"')
  })

  it('«Подробные метрики» выключаются на время импорта', () => {
    const link = elementAround('@click="openMetrics"')
    expect(link).toContain(':disabled="busy"')
  })

  it('у обеих кнопок сказана ПРИЧИНА, а не только погашен вид', () => {
    // Выключенная кнопка без объяснения неотличима от сломанной — тот же довод, по которому в #411
    // завели подсказку вместо молчания.
    expect(elementAround(':icon="SettingsIcon"')).toContain('Пока идёт импорт')
    expect(elementAround('@click="openMetrics"')).toContain('Пока идёт импорт')
  })

  it('`pointer-events-none` больше не используется как замок на интерактивных блоках', () => {
    // Негативная половина: без неё вернуть дырявый замок можно было бы, не уронив ничего. Осталось
    // ровно одно вхождение — в `ImportStaging`, и то на НЕинтерактивной обёртке списка файлов.
    const staging = readFileSync(new URL('../app/components/ImportStaging.vue', import.meta.url).pathname, 'utf8')
    const withPicker = staging.slice(staging.indexOf('<TargetPicker') - 400, staging.indexOf('<TargetPicker'))
    expect(withPicker).not.toContain('pointer-events-none')
  })
})
