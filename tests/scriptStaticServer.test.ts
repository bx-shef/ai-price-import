import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSafePath } from '../scripts/lib/staticPath.mjs'

/**
 * Локальные файловые серверы в `scripts/` не отдают ничего за пределами каталога сборки
 * и слушают только петлевой адрес.
 *
 * ЗАЧЕМ. Два скрипта поднимают HTTP-сервер над `.output/public`, чтобы прогнать по собранному сайту
 * браузер: `screenshot.mjs` (снимки) и `probe-overflow.mjs` (проба переполнения). `screenshot.mjs`
 * закрыл обе дыры с самого начала и даже объяснил это комментарием — а `probe-overflow.mjs`,
 * написанный позже по его образцу, защиту НЕ повторил (#523, нашёл проверяющий по безопасности).
 * Проверено сырым сокетом: `GET /../../../../etc/passwd` отдавал файл с кодом 200.
 *
 * ⚠ Через `fetch` и `curl` это НЕ воспроизводится — они схлопывают `..` на своей стороне и до
 * сервера его не доносят. Отсюда правило: дыру такого рода проверяют запросом без клиентской
 * нормализации, иначе «не воспроизвелось» читается как «уязвимости нет».
 *
 * ⚠ ПРОВЕРКА ПОВЕДЕНИЕМ, А НЕ ТЕКСТОМ — и это вторая купленная находка. Первая редакция гарда
 * искала в исходнике подстроку `startsWith(PUBLIC_DIR + sep)`. Мутация «убрать один символ `!`»
 * подстроку не трогает, а смысл переворачивает целиком: безопасные пути получают 403, обход
 * каталога отдаётся. Гард оставался зелёным. Поэтому замок вынесен в чистую `resolveSafePath`, и
 * ниже проверяется он сам, а не то, как он записан.
 */

const ROOT = new URL('..', import.meta.url).pathname
const SCRIPTS = resolve(ROOT, 'scripts')
const read = (f: string) => readFileSync(resolve(SCRIPTS, f), 'utf8')
/** Комментарии режем: в них законно цитируется сам дефект. */
const strip = (src: string) => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

const servers = readdirSync(SCRIPTS)
  .filter(f => f.endsWith('.mjs'))
  .filter(f => strip(read(f)).includes('createServer('))

const BASE = '/build/public'

describe('#523: замок пути у локальных серверов', () => {
  it('обычный путь резолвится внутрь каталога сборки', () => {
    // ⚠ Этот случай и ловит ИНВЕРСИЮ условия: с перевёрнутым замком обычный путь отвергается.
    expect(resolveSafePath(BASE, '/app.js')).toBe(`${BASE}/app.js`)
    expect(resolveSafePath(BASE, '/settings/')).toBe(`${BASE}/settings/index.html`)
    expect(resolveSafePath(BASE, '/settings/?x=1')).toBe(`${BASE}/settings/index.html`)
  })

  for (const attack of [
    '/../../../../etc/passwd',
    '/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
    '/a/../../../../../etc/shadow',
    '/..%2f..%2f.env',
    '/./../../.env'
  ]) {
    it(`обход каталога не выходит за базу: ${attack}`, () => {
      const out = resolveSafePath(BASE, attack)
      // Либо отказ, либо путь ВНУТРИ базы — третьего быть не должно. Формулировка именно такая,
      // потому что часть попыток схлопывает уже `normalize`, и требовать от них `null` значило бы
      // сторожить деталь реализации вместо самого свойства.
      if (out !== null) expect(out.startsWith(`${BASE}/`), `${attack} → ${out}`).toBe(true)
      expect(out === null || !out.includes('..')).toBe(true)
    })
  }

  it('битая процентная последовательность — отказ, а не падение сервера', () => {
    expect(resolveSafePath(BASE, '/%ZZ')).toBeNull()
  })

  it('соседний каталог с общим префиксом имени не считается своим', () => {
    // Ради этого в условии стоит `+ sep`, а не голый префикс: `/build/public-old` начинается с
    // `/build/public`, но своим каталогом не является.
    expect(resolveSafePath('/build/public', '/x')).toBe('/build/public/x')
    expect(resolveSafePath('/build/public-old', '/x')).toBe('/build/public-old/x')
  })
})

describe('#523: локальные файловые серверы в scripts/', () => {
  it('такие скрипты вообще есть — иначе проверка молча ничего не сторожит', () => {
    // Без этого переименование `screenshot.mjs`/`probe-overflow.mjs` оставило бы пустой список, и
    // весь блок ниже проходил бы, не проверив ни строчки.
    expect(servers.length, 'ни одного скрипта с createServer не найдено').toBeGreaterThanOrEqual(2)
  })

  for (const file of servers) {
    it(`${file}: путь из запроса проходит через общий замок`, () => {
      // Своя копия замка — то, с чего дефект и начался: в `screenshot.mjs` он был, во втором
      // скрипте его забыли. Одно место на оба, и оно покрыто поведением выше.
      expect(strip(read(file)), 'скрипт резолвит путь сам, мимо общего замка').toMatch(/resolveSafePath\(/)
    })

    it(`${file}: сервер слушает только 127.0.0.1`, () => {
      const src = strip(read(file))
      expect(src, 'listen без хоста слушает 0.0.0.0 — порт виден по сети').toMatch(/\.listen\(\s*0\s*,\s*'127\.0\.0\.1'/)
    })
  }
})
