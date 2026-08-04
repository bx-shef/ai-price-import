import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_NAME, APP_SLUG } from '../app/config/appIdentity'
import { LANDING_TITLE } from '../app/utils/landing'

// #412. Имя продукта обязано быть ОДНО и совпадать символ в символ везде: в карточке Маркета, в
// шапке лицензии, в шапке Политики и в интерфейсе. До этой задачи оно жило тремя независимыми
// строками в коде плюс отдельной в заголовке лендинга — и «символ в символ» держалось только на
// внимательности правящего.

const ROOT = new URL('../', import.meta.url).pathname
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** Рекурсивно — все исходники приложения и сервера. */
function sources(): string[] {
  const out: string[] = []
  for (const root of ['app', 'server', 'prompts']) {
    for (const name of readdirSync(join(ROOT, root), { recursive: true }) as string[]) {
      if (!/\.(ts|vue|mts)$/.test(name)) continue
      const full = join(ROOT, root, name)
      if (statSync(full).isDirectory()) continue
      out.push(full)
    }
  }
  return out
}

describe('#412: имя продукта — один источник', () => {
  it('литерал имени не написан второй раз мимо конфига', () => {
    // ⚠ Гард по ИСХОДНИКАМ, а не по выводу: вторая копия строки прошла бы любой рендер-тест, а
    // разъехалась бы позже и незаметно — увидели бы по чужому скриншоту.
    const offenders = sources()
      .filter(f => !f.endsWith('config/appIdentity.ts'))
      .filter(f => readFileSync(f, 'utf8').includes(`'${APP_NAME}'`) || readFileSync(f, 'utf8').includes(`"${APP_NAME}"`))
      .map(f => f.replace(ROOT, ''))
    expect(offenders, `имя продукта переписано литералом — берите APP_NAME:\n${offenders.join('\n')}`).toEqual([])
  })

  it('заголовок лендинга — это имя продукта', () => {
    expect(LANDING_TITLE).toBe(APP_NAME)
  })

  it('в имени продукта нет чужого товарного знака', () => {
    // Требование юридического пакета: платформа упоминается в описании и подзаголовке, но не
    // внутри собственного названия.
    expect(APP_NAME).not.toMatch(/bitrix|битрикс/i)
    expect(APP_SLUG).not.toMatch(/bitrix|битрикс/i)
  })

  it('имя из шапок юридических документов совпадает символ в символ', () => {
    // Критерий приёмки #412. Документы уходят наружу; расхождение с интерфейсом там заметит
    // модератор Маркета, а не мы.
    for (const doc of ['docs/eula.md', 'docs/privacy-policy.md']) {
      expect(read(doc), `${doc}: имя продукта не совпадает с APP_NAME`).toContain(APP_NAME)
    }
  })

  it('старое имя не осталось в том, что видит человек', () => {
    // `legacy/` — архив старого проекта, он намеренно вне правила. Инфраструктурные
    // идентификаторы (образы, контейнеры, база) тоже: их смена требует действий на сервере, и они
    // человеку не показываются — см. PROCESS.md.
    const dirty = sources().filter((f) => {
      // ⚠ Комментарии вырезаются: они ОБЪЯСНЯЮТ, почему прежнее имя где-то осталось, и гард,
      // краснеющий на пояснении, подталкивает удалить пояснение, а не дефект. Тот же урок, что с
      // гардом аналитики, где проверка проходила по фразе в комментарии.
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
      // Ключ настроек портала намеренно оставлен прежним — его переименование обнулило бы
      // настройки всех установленных порталов.
      return /procure-ai/i.test(src) && !src.includes('SETTINGS_KEY')
    }).map(f => f.replace(ROOT, ''))
    expect(dirty, `старое имя в исходниках:\n${dirty.join('\n')}`).toEqual([])
  })
})
