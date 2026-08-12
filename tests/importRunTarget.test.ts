import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

// #488. Выбор «Куда» принадлежит сотруднику, и трогать его вправе только он сам — либо исчезновение
// самого маршрута. Гарды ниже сторожат обе стороны этого правила.

describe('#488: событие настроек НЕ трогает выбор сотрудника', () => {
  // ⚠ Правила маршрутизации применяются только к «Авто» — в этом весь его смысл. Прежняя редакция
  // сбрасывала выбор на КАЖДОЕ сохранение: у бухгалтера, весь день грузящего накладные в одно
  // направление, он молча слетал от правки словаря единиц в соседней вкладке.
  it('обработчик события не присваивает цель', () => {
    // ⚠ Комментарии вырезаются ДО поиска: разбор в них законно называет и `TargetPicker`, и
    // прежний механизм — гард, краснеющий на пояснении, подталкивает удалить пояснение, а не дефект.
    const page = read('app/pages/app.vue').replace(/^\s*\/\/.*$/gm, '')
    const handler = page.split('subscribeReload(async () => {')[1]?.split('\n})')[0] ?? ''
    expect(handler, 'обработчик не найден — подпись изменилась').not.toBe('')
    // ⚠ Регистронезависимо: первая редакция искала строчное `target` и пропускала
    // `adoptSettingsTarget()` — то есть возврат прежнего механизма проходил бы бесследно
    // (найдено разбором мутацией).
    expect(handler).not.toMatch(/target/i)
    expect(handler).not.toMatch(/stagingRef/i)
  })

  it('единственная смена цели — негодный маршрут, и она ОБЪЯВЛЯЕТСЯ', () => {
    // Молчаливая замена запрещена: человек увидел бы в поле другое значение и не понял, почему.
    const vue = read('app/components/ImportStaging.vue')
    expect(vue).toContain('targetInvalidMessage(reason, true)')
    expect(vue).toContain('@invalid="onTargetInvalid"')
  })
})

describe('#443/#349: цель пачки заморожена на прогон', () => {
  it('цикл отправки читает СНИМОК, а не живое значение', () => {
    // ⚠ Замок на пикере и снимок — ДВА независимых замка. Пикер защищает от руки, снимок от кода:
    // с рассылкой настроек менять цель на середине пачки стало кому, а исход на экране невидим —
    // половина накладных в одной воронке, половина в другой, и вскрывается это только в CRM.
    const vue = readFileSync(resolve(import.meta.dirname, '..', 'app/components/ImportStaging.vue'), 'utf8')
    expect(vue).toContain('const runTarget = target.value')
    expect(vue).toContain('props.upload(s.file, runTarget, s.key)')
    expect(vue).not.toContain('props.upload(s.file, target.value')
  })
})
