import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { B24_FORM_FALLBACK, firstFilled } from '../app/config/runtimeDefaults'

/**
 * Пустое присваивание в `.env` ПЕРЕБИВАЕТ умолчание (#305).
 *
 * МЕХАНИКА, проверенная на живом `docker compose config` и на самом Nitro:
 *
 * | строка в `.env` | что видит контейнер            |
 * |-----------------|--------------------------------|
 * | `KEY=`          | `''` — значение образа отброшено |
 * | `KEY` (без `=`) | ключа нет, значение образа проходит |
 * | строки нет      | значение образа проходит        |
 *
 * `applyEnv` делает `obj[key] = envValue ?? obj[key]`, а `destr('')` возвращает `''`, не `undefined`.
 *
 * ⚠ ЗАЧЕМ ЭТОТ ГАРД. Задача #305 просила «проверить поимённо остальные пустые присваивания», и они
 * были проверены — человеком, один раз, в июле. Дальше это держалось на честном слове: новый ключ с
 * непустым умолчанием и пустой строкой в примере вернул бы дефект молча, а симптом (пропавшая форма
 * заявки, версия «dev» на проде) не выглядит как ошибка конфигурации. Теперь сверка идёт на каждом CI.
 */

const ROOT = new URL('..', import.meta.url).pathname
const example = readFileSync(resolve(ROOT, '.env.example'), 'utf8')
const nuxtConfig = readFileSync(resolve(ROOT, 'nuxt.config.ts'), 'utf8')

/** Ключи, присвоенные ПУСТЫМИ в примере (именно `KEY=`, без значения и не закомментированные). */
const emptyAssignments = example
  .split('\n')
  .map(l => l.trim())
  .filter(l => /^[A-Z_][A-Z0-9_]*=$/.test(l))
  .map(l => l.slice(0, -1))

/**
 * Публичные ключи с НЕПУСТЫМ умолчанием в `nuxt.config.ts`.
 *
 * Читаем сам конфиг, а не список руками: переписанный руками список разошёлся бы с кодом, и гард
 * сторожил бы вчерашнюю правду. Ищем поля `runtimeConfig.public`, у которых значение — непустая
 * строка или выражение с `||` (то есть умолчание есть).
 */
function publicKeysWithDefaults(): string[] {
  const block = nuxtConfig.slice(nuxtConfig.indexOf('public: {'), nuxtConfig.indexOf('future:'))
  const out: string[] = []
  for (const m of block.matchAll(/^\s*(\w+):\s*(.+?),?\s*$/gm)) {
    const [, name, raw] = m
    if (!name || !raw) continue
    const value = raw.trim()
    if (value === '\'\'' || value === '""') continue // пустое умолчание — пустая строка безопасна
    if (value.startsWith('//') || value === '{') continue // комментарий и открытие самого блока
    out.push(envNameFor(name))
  }
  return out
}

/** `b24FormId` → `NUXT_PUBLIC_B24_FORM_ID`: та же схема, что применяет сам Nuxt. */
function envNameFor(camel: string): string {
  return `NUXT_PUBLIC_${camel.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])(\d)/g, '$1_$2').toUpperCase()}`
}

describe('#305: пример конфигурации не выключает то, у чего есть умолчание', () => {
  it('САМ РАЗБОР работает — иначе проверка ниже сравнивает пустое с пустым', () => {
    // ⚠ Без этой проверки гард вырождается молча: стоит переформатировать `nuxt.config.ts` (или
    // записать поле сокращённой формой `metrikaId,` — её разбор НЕ ловит), и список умолчаний станет
    // пустым, а «опасных ключей нет» останется зелёным навсегда. Это ровно тот класс, который в
    // этом проекте ловили уже трижды: проверка, которая верна, потому что ничего не проверяет.
    const keys = publicKeysWithDefaults()
    expect(keys, 'разбор nuxt.config.ts не нашёл ни одного умолчания').not.toHaveLength(0)
    // Поимённо — это те, чьи умолчания непусты и чья потеря давала наблюдавшиеся симптомы.
    for (const known of ['NUXT_PUBLIC_COMMIT_SHA', 'NUXT_PUBLIC_B24_FORM_ID', 'NUXT_PUBLIC_B24_FORM_SECRET', 'NUXT_PUBLIC_B24_FORM_SCRIPT_URL']) {
      expect(keys, `разбор перестал видеть ${known}`).toContain(known)
    }
  })

  it('ни один ключ с непустым умолчанием не присвоен пустым', () => {
    // ⚠ Ровно этот дефект и наблюдался: скопировавший `.env.example` в `.env` получал лендинг БЕЗ
    // формы заявки, а прод рапортовал версию «dev» вместо настоящей sha.
    const dangerous = publicKeysWithDefaults().filter(k => emptyAssignments.includes(k))
    expect(dangerous, `в .env.example пустыми присвоены ключи с непустым умолчанием: ${dangerous.join(', ')}`).toEqual([])
  })

  it('ключи формы заявки и версии сборки в примере ЗАКОММЕНТИРОВАНЫ', () => {
    // Поимённо, потому что именно они дали два наблюдавшихся симптома. Закомментированная строка
    // объясняет ключ и НЕ передаёт его в контейнер; строка `KEY=` изображает «выключено» и выключает.
    for (const key of ['NUXT_PUBLIC_COMMIT_SHA', 'NUXT_PUBLIC_B24_FORM_ID', 'NUXT_PUBLIC_B24_FORM_SECRET', 'NUXT_PUBLIC_B24_FORM_SCRIPT_URL']) {
      expect(emptyAssignments, `${key} присвоен пустым — он выключит умолчание`).not.toContain(key)
      expect(example, `${key} пропал из примера вовсе — оператор о нём не узнает`).toContain(key)
    }
  })
})

describe('#305: пустая переменная не выключает форму заявки В РАНТАЙМЕ', () => {
  // ⚠ Умолчания в `nuxt.config.ts` стоят через `process.env.X || '…'`, но это читается НА СБОРКЕ. На
  // развёртывании одним процессом Nitro (Вайбкод) переменная перебивает значение уже на ЗАПУСКЕ, и
  // сборочное умолчание не спасает. Документ до 13.08.2026 утверждал обратное — это было верно
  // только для статической выкладки за nginx.
  it('пустое и пробельное значение уступают умолчанию', () => {
    expect(firstFilled('', B24_FORM_FALLBACK.id)).toBe(B24_FORM_FALLBACK.id)
    expect(firstFilled('   ', B24_FORM_FALLBACK.id)).toBe(B24_FORM_FALLBACK.id)
    expect(firstFilled(undefined, B24_FORM_FALLBACK.id)).toBe(B24_FORM_FALLBACK.id)
  })

  it('заданное значение ВЫИГРЫВАЕТ у умолчания — переопределение обязано работать', () => {
    // Обратная половина: защита от пустоты не должна превратиться в «умолчание всегда».
    expect(firstFilled('7', B24_FORM_FALLBACK.id)).toBe('7')
  })

  it('форма читает значения через защиту от пустоты, а не напрямую', () => {
    const vue = readFileSync(resolve(ROOT, 'app/components/BriefForm.vue'), 'utf8')
    expect(vue).toMatch(/firstFilled\(config\.public\.b24FormScriptUrl/)
    expect(vue).toMatch(/firstFilled\(config\.public\.b24FormId/)
    expect(vue).toMatch(/firstFilled\(config\.public\.b24FormSecret/)
  })
})
