import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { adoptDefaultTarget } from '../app/utils/settingsAdopt'

// #443. Событие «настройки изменились» широковещательное: админ сохранил настройки — оно прилетает
// ВСЕМ сотрудникам портала. У каждого на экране может быть свой выбор направления, запомненный на
// вкладку (#349), и вопрос «кто побеждает» решается правилом, а не порядком вызовов.

describe('#443: цель вкладки при смене настроек портала', () => {
  it('настройка портала побеждает: выбор вкладки сбрасывается', () => {
    expect(adoptDefaultTarget({ importing: false })).toEqual({ apply: true })
  })

  it('идущая пачка НЕ затрагивается — правка ОТКЛАДЫВАЕТСЯ', () => {
    // ⚠ Обязательное, а не желательное: задания уже приняты сервером, и их поведение определяется
    // настройками НА МОМЕНТ ПОСТАНОВКИ. Подменить цель посреди пачки значило бы показать человеку
    // не то, куда на самом деле уедут его документы.
    expect(adoptDefaultTarget({ importing: true })).toEqual({ apply: false, reason: 'importing' })
  })
})

describe('#443: сброс идёт на «Авто», а не на цель по умолчанию', () => {
  // ⚠ Несущее утверждение, и стоит оно отдельным гардом потому, что подмена невидима глазами:
  // экран выглядел бы одинаково, а маршрутизация была бы выключена у всего портала. Цель по
  // умолчанию ВСЕГДА конкретна, в задании она становится ручным выбором, а ручной выбор бьёт выше
  // правил маршрутизации — значит любое сохранение настроек выключало бы правила (разбор PR #476).
  const root = resolve(import.meta.dirname, '..')
  const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

  it('решение НЕ принимает цель по умолчанию на вход — принять её нечем', () => {
    // Структурно: если у правила нет входа `defaultTarget`, подставить её обратно можно только
    // осознанной правкой сигнатуры, а не случайной строкой в компоненте.
    const src = read('app/utils/settingsAdopt.ts')
    const iface = src.slice(src.indexOf('export interface AdoptInput'), src.indexOf('/**\n * Decide'))
    expect(iface).not.toContain('defaultTarget')
  })

  it('приёмник события ставит именно `null`, а не значение из настроек', () => {
    const vue = read('app/components/ImportStaging.vue')
    const fn = vue.slice(vue.indexOf('function adoptSettingsTarget'), vue.indexOf('defineExpose'))
    expect(fn).toContain('target.value = null')
    expect(fn).not.toContain('defaultTarget')
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
