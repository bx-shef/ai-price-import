import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readEnvValue } from '../scripts/lib/envFile.mjs'

// Общий парсер `.env` для живых скриптов. До него копий было пять, и они разъехались — а читается
// здесь адрес портала и токены, поэтому каждое расхождение уводило прогон на чужие данные либо
// делало исправный портал похожим на сломанный. Ниже проверяется ровно то, чем копии отличались.

function envFile(body: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'envfile-')), '.env.test')
  writeFileSync(p, body)
  return p
}

describe('readEnvValue', () => {
  it('берёт ПОСЛЕДНЕЕ вхождение, а не первое', () => {
    // ⚠ Главный разъезд: три копии брали первое, одна — последнее. Дописав новый адрес в конец
    // файла, разработчик ходил частью проверок на прежний портал, частью на новый; хуже всего, что
    // часть при этом зелена, часть красна, и обе врут о причине.
    const f = envFile('B24_HOOK=старый\nB24_HOOK=новый\n')
    expect(readEnvValue(f, 'B24_HOOK')).toBe('новый')
  })

  it('снимает кавычки', () => {
    // ⚠ `verify:idem` их не снимал вовсе, а `"https://…/"` — обычное написание в .env: адрес
    // уезжал с кавычкой внутри, REST отвечал невнятно, и это читалось как поломка портала.
    const f = envFile('B24_TEST_WEBHOOK="https://портал/rest/1/ключ/"\n')
    expect(readEnvValue(f, 'B24_TEST_WEBHOOK')).toBe('https://портал/rest/1/ключ/')
  })

  it('закомментированную строку не читает', () => {
    const f = envFile('#B24_HOOK=старый\nB24_HOOK=живой\n')
    expect(readEnvValue(f, 'B24_HOOK')).toBe('живой')
  })

  it('переменную, ЗАКАНЧИВАЮЩУЮСЯ на искомое имя, не читает', () => {
    const f = envFile('OLD_B24_HOOK=чужой\n')
    expect(() => readEnvValue(f, 'B24_HOOK')).toThrow(/не задан/)
  })

  it('принимает `export KEY=…`', () => {
    const f = envFile('export B24_HOOK=через-export\n')
    expect(readEnvValue(f, 'B24_HOOK')).toBe('через-export')
  })

  it('пустое значение считается отсутствующим', () => {
    // ⚠ Пустое присваивание в .env — способ ВЫКЛЮЧИТЬ переменную, а не задать пустой адрес: иначе
    // скрипт пошёл бы стучаться по пустому URL и сообщил бы про сеть, а не про настройку.
    const f = envFile('B24_HOOK=\n')
    expect(() => readEnvValue(f, 'B24_HOOK')).toThrow(/не задан/)
    expect(readEnvValue(f, 'B24_HOOK', { required: false })).toBe('')
  })

  it('нет файла: бросок либо пустая строка — по требованию вызывающего', () => {
    const missing = join(tmpdir(), 'нет-такого-файла-envfile')
    expect(() => readEnvValue(missing, 'B24_HOOK')).toThrow(/не найден/)
    expect(readEnvValue(missing, 'B24_HOOK', { required: false })).toBe('')
  })
})
