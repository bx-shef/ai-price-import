import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Границы веб-аналитики (#297, решение владельца 2026-08-04: счётчик нужен — по нему ведут рекламу
// и смотрят клики).
//
// Гард сторожит не «есть счётчик или нет», а ТРИ границы, каждая из которых держит утверждение
// опубликованного документа. Нарушить любую можно одним словом в конфиге, и ничего не сломается
// видимым образом — отчёты просто начнут содержать то, чего обещали не собирать.
//
//   1. **Счётчик не поднимается во фрейме.** In-portal экраны живут в iframe портала клиента.
//      Счётчик там писал бы работу сотрудника в чужой CRM — данные, которые нам не принадлежат и
//      о которых клиент не давал согласия; плюс цели лендинга смешались бы с портальным трафиком.
//   2. **Вебвизор выключен.** Он записывает сессию и содержимое форм. На лендинге стоит
//      демо-разбор: посетитель грузит туда накладную, и запись сессии унесла бы её содержимое на
//      сторону Яндекса. Политика сайта обещает ровно обратное — «содержимое документов в аналитику
//      не передаётся».
//   3. **Идентификатор только из env.** Захардкоженный id включил бы счётчик издателя на
//      self-hosted инсталляции клиента и на любом форке — чужой сайт слал бы отчёты нам.

const ROOT = new URL('..', import.meta.url).pathname
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * Разрешённые приёмники аналитики — ВЫВЕДЕНЫ из действующей политики, а не переписаны рядом.
 *
 * ⚠ Рукописная копия уже разъехалась: список приёмников стал региональным в `nginx.conf` и в
 * `edgeSecurity.ts`, а здесь остался прежним — и `public/metrika.js` с вписанным `mc.yandex.by`
 * проходил скан молча, то есть ровно тот обход, ради которого скан и заведён (счётчик издателя,
 * подложенный в статику и работающий на инсталляции клиента).
 */
const ALLOWED_ANALYTICS_HOSTS = [...new Set(
  (read('server/utils/edgeSecurity.ts').match(/mc\.yandex\.[a-z.]+/g) ?? [])
)]
const FOREIGN_ANALYTICS_HOSTS = ['google-analytics.com', 'googletagmanager.com', 'top-fwz1.mail.ru', 'top.mail.ru']

/**
 * Конфиг БЕЗ комментариев.
 *
 * ⚠ Иначе гард сторожит прозу. Именно так и вышло при #404: сниппет переписали на ранний выход
 * (`window.self!==window.top`), тест остался зелёным — и не потому, что код верен, а потому что
 * фраза `window.self===window.top` попала в комментарий рядом. Проверять надо исполняемый текст.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
}

describe('границы веб-аналитики (#297)', () => {
  const config = stripComments(read('nuxt.config.ts'))

  it('счётчик самозаглушается во фрейме — в портале он не работает', () => {
    // Условие стоит ВНУТРИ сниппета, до создания тега: без него счётчик поднимется в каждом
    // in-portal экране, и это не будет заметно ниоткуда, кроме отчётов Метрики.
    expect(config, 'нет гарда window.self===window.top').toMatch(/window\.self\s*===\s*window\.top/)
    // И сам тег создаётся только внутри этого условия: проверяем порядок, а не наличие строки.
    const guardAt = config.indexOf('window.self===window.top')
    const tagAt = config.indexOf('mc.yandex.ru/metrika/tag.js')
    expect(guardAt, 'гард фрейма не найден').toBeGreaterThan(-1)
    expect(tagAt, 'тег счётчика не найден').toBeGreaterThan(-1)
    expect(tagAt > guardAt, 'тег создаётся ДО проверки фрейма').toBe(true)
  })

  it('Вебвизор выключен — содержимое демо-документов не пишется', () => {
    expect(config, 'webvisor не выключен явно').toMatch(/webvisor\s*:\s*false/)
    expect(config, 'webvisor включён').not.toMatch(/webvisor\s*:\s*true/)
  })

  it('идентификатор счётчика берётся из env, а не зашит в код', () => {
    // `.replace(/\D/g,'')` — не косметика: он же превращает мусор в пустую строку, а пустая строка
    // выключает счётчик целиком (ветка `metrikaId ? … : []`).
    expect(config).toMatch(/process\.env\.NUXT_PUBLIC_METRIKA_ID/)
    // Захардкоженный числовой id рядом с инициализацией — ровно то, что уносит чужие отчёты нам.
    expect(config, 'id счётчика зашит в код').not.toMatch(/ym\(\s*\d{5,}/)
    expect(config, 'счётчик подключается без проверки id').toMatch(/metrikaId\s*\?/)
  })

  it('в public/ нет второго счётчика мимо конфига', () => {
    // Скрипт в `public/` подключается тегом и проходит мимо ревью Vue-кода и мимо всех гардов выше.
    for (const name of readdirSync(join(ROOT, 'public'))) {
      if (!name.endsWith('.js') && !name.endsWith('.html')) continue
      const src = read(`public/${name}`)
      for (const host of [...ALLOWED_ANALYTICS_HOSTS, ...FOREIGN_ANALYTICS_HOSTS]) {
        expect(src, `public/${name}: ${host}`).not.toContain(host)
      }
    }
  })

  it('CSP разрешает только приёмники Метрики — чужих систем аналитики нет', () => {
    // connect-src — канал, по которому со страницы уходят данные. Появление там нового хоста
    // означает нового получателя, а это правка документа (раздел «кому передаются данные»), а не
    // строчка в конфиге.
    for (const f of ['nginx.conf', 'server/utils/edgeSecurity.ts']) {
      const src = read(f)
      for (const host of FOREIGN_ANALYTICS_HOSTS) {
        expect(src, `${f}: ${host} разрешён в CSP`).not.toContain(host)
      }
      expect(src, `${f}: приёмник Метрики не разрешён — счётчик будет молча заблокирован`).toContain('mc.yandex.ru')
      // ⚠ Вебвизор запрещён НЕ только флагом в сниппете, но и отсутствием его приёмников в
      // политике: это вторая линия, и она самая дорогая для этого продукта — на лендинге стоит
      // разбор чужой накладной, и запись сессии унесла бы её содержимое на сторону. Флаг может
      // быть перевёрнут одной правкой; хост в CSP — осознанное решение, и его отсутствие
      // закрепляется здесь.
      for (const host of ['mc.webvisor.com', 'mc.webvisor.org']) {
        expect(src, `${f}: разрешён приёмник Вебвизора`).not.toContain(host)
      }
    }
  })
})
