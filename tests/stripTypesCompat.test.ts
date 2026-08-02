import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Живые проверки (`pnpm sdk:smoke`, `live:crm`, `verify:idem`, `verify:332`, `verify:fail`,
// `verify:chat`, `ab:prompt`) запускают ПРОДОВЫЙ код через `node --experimental-strip-types`.
// Этот режим только СТИРАЕТ типы и не умеет генерировать код — а параметр-свойство
// (`constructor(readonly code: string)`) требует именно генерации присваивания. Одно такое поле
// в `b24Rest.ts` роняло `pnpm sdk:smoke` на разборе файла: скрипт не стартовал вовсе.
//
// Почему это стоит теста, а не памяти: сборка приложения через Vite такой синтаксис принимает,
// typecheck молчит, тесты зелены. Ломается ТОЛЬКО инструмент живой проверки — и узнать об этом
// можно лишь в тот момент, когда он понадобился, то есть в разгар разбора живого дефекта.
const ROOT = new URL('../', import.meta.url).pathname
const ROOTS = ['server', 'app', 'prompts']

/** Все .ts проекта, которые может утащить импорт из dev-скрипта. */
function sources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) sources(full, acc)
    else if (name.endsWith('.ts')) acc.push(full)
  }
  return acc
}

/**
 * Параметр-свойства в объявлении конструктора.
 *
 * Ищем модификатор ПЕРЕД именем параметра внутри `constructor(...)`. Однострочная форма покрывает
 * все нынешние случаи; многострочные конструкторы разбираем по строкам того же вызова.
 */
function parameterProperties(text: string): string[] {
  const found: string[] = []
  for (const m of text.matchAll(/constructor\s*\(([^)]*)\)/gs)) {
    const params = m[1]!
    if (/(^|[(,\s])(readonly|private|public|protected)\s+\w/.test(params)) found.push(params.trim().slice(0, 80))
  }
  return found
}

describe('живые проверки должны запускаться (--experimental-strip-types)', () => {
  it('в коде нет параметр-свойств конструктора', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of sources(join(ROOT, root))) {
        for (const p of parameterProperties(readFileSync(file, 'utf8'))) {
          offenders.push(`${file.replace(ROOT, '')} → constructor(${p})`)
        }
      }
    }
    expect(
      offenders,
      'параметр-свойство не переживает --experimental-strip-types: объявите поле отдельно и присвойте в теле\n' + offenders.join('\n')
    ).toEqual([])
  })
})
