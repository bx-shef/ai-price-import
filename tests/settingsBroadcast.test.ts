import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// #443. Три решения в рассылке настроек держались НИ НА ЧЁМ: ревью мутировало каждое обратно в
// доправочный вид, и весь набор из 2498 тестов оставался зелёным. Каждое при этом закрывает свой
// дефект, и все три — молчаливые: сломавшись, они не роняют экран и не пишут в журнал.
//
// ⚠ Гард СТРУКТУРНЫЙ и назван таковым. `app/pages/app.vue` и `app/pages/settings.vue` в наборе не
// монтируются нигде, а поднимать страницу целиком ради трёх строк значило бы застабить полтора
// десятка композаблов, то есть проверять не её. Проверяется ФОРМА конкретных мест, а не наличие
// подстроки где-нибудь в файле: греп «есть ли слово `await`» прошёл бы и на другой строке.
//
// ⚠ Что этим НЕ проверено и почему это записано: гард не доказывает, что рассылка доходит. Он
// доказывает, что три принятых решения не откатились молча. Живая проверка доставки — за
// владельцем, пункт открыт в #443.

const read = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, 'utf8')
const APP = read('../app/pages/app.vue')
const SETTINGS = read('../app/pages/settings.vue')

/** Тело функции по её сигнатуре — чтобы проверять ПОРЯДОК внутри, а не вхождение в файл. */
function body(src: string, signature: string): string {
  const at = src.indexOf(signature)
  expect(at, `не найдено: ${signature}`).toBeGreaterThan(-1)
  const from = src.indexOf('{', at)
  let depth = 0
  for (let i = from; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1)
  }
  throw new Error(`не закрылось тело: ${signature}`)
}

describe('#443: рассылка настроек — три решения, которые не должны откатиться молча', () => {
  it('счётчик правок растёт ТОЛЬКО на успешной загрузке', () => {
    // ⚠ `useSettings.load()` не бросает никогда: на 401/502 он ставит `loadError` и ОСТАВЛЯЕТ
    // `mapping` прежним. Прежний `.finally` отменял сотруднику ручной выбор цели и при отказе —
    // ничего не узнав взамен и молча, потому что ошибка загрузки настроек на `/app` не выводится.
    const handler = body(APP, 'const unsubscribeReload = subscribeReload(')
    expect(handler).not.toContain('.finally(')
    expect(handler).toMatch(/loadSettings\(\)\.then\(/)
    expect(handler).toMatch(/if \(!settingsLoadError\.value\) settingsVersion\.value\+\+/)
  })

  it('рассылка ОЖИДАЕТСЯ перед закрытием слайдера, и ожидание ограничено', () => {
    // ⚠ `void notifyReload()` летел из фрейма, который следующая строка уничтожает: успел браузер
    // отправить POST — рассылка ушла, не успел — её не получил НИКТО.
    // ⚠ Но ждать без предела нельзя: у axios SDK таймаут 30 с и до трёх ретраев на сетевой ошибке,
    // то есть мёртвый pull-эндпоинт держал бы слайдер открытым до двух минут.
    const fn = body(SETTINGS, 'async function saveAndClose(')
    expect(fn).not.toMatch(/void\s+notifyReload/)
    expect(fn).toContain('Promise.race([notifyReload()')
    expect(fn).toContain('NOTIFY_WAIT_MS')
    expect(fn.indexOf('notifyReload()')).toBeLessThan(fn.indexOf('closeAfter()'))
  })

  it('форма выключена на время ожидания рассылки', () => {
    // ⚠ `saving` к этому моменту уже `false`. Без своего флага «Отмена» уничтожает фрейм ПОСРЕДИ
    // незавершённого запроса — то есть возвращает ровно ту потерю, ради устранения которой
    // ожидание и заведено, только руками человека.
    const fn = body(SETTINGS, 'async function saveAndClose(')
    expect(fn).toContain('closing.value = true')
    // Обе кнопки подвала — и «Сохранить», и «Отмена».
    expect(SETTINGS.match(/:disabled="saving \|\| closing/g) ?? []).toHaveLength(2)
  })

  it('подписка снимается ТОЛЬКО там, где пусковая страница ею и остаётся', () => {
    // ⚠ Прежде она снималась первой строкой, до попытки открыть слайдер: на портале, где слайдеры
    // не открываются, экран уходил в рабочий режим с НАВСЕГДА мёртвым каналом — то есть посылка
    // «событие уходит всем» ломалась именно там, где проверить её труднее всего.
    const branch = APP.slice(APP.indexOf('if (launch.value === \'launcher\') {'))
    const cut = branch.slice(0, branch.indexOf('launch.value = \'work\''))
    // Оба снятия стоят ПОСЛЕ решения открывать слайдер, а не до него.
    expect(cut.indexOf('canAutoOpenMain')).toBeLessThan(cut.indexOf('unsubscribeReload()'))
    expect((cut.match(/unsubscribeReload\(\)/g) ?? []).length).toBe(2)
    // И ни одного снятия на пути «слайдер не открылся → работаем».
    const fallback = branch.slice(branch.indexOf('launch.value = \'work\''))
    expect(fallback.slice(0, fallback.indexOf('}'))).not.toContain('unsubscribeReload')
  })
})
