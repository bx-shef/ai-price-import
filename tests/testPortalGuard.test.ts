import { describe, expect, it } from 'vitest'
import { assertTestPortal } from '../scripts/lib/testPortalGuard.mjs'

/**
 * Защита живых проверок от запуска на БОЕВОМ портале клиента.
 *
 * ⚠ Гарда у самого гарда не было вовсе — пробел заметил проверяющий при разборе PR #502. Цена
 * молчания здесь высокая и несимметричная: скрипты `verify:*` создают чат и пишут в него, а чат в
 * Bitrix24 по REST **не удаляется** — на портале клиента навсегда остался бы мусорный чат. Ошибка в
 * эту сторону не видна ни в CI, ни на код-ревью: список доменов выглядит как безобидная константа,
 * а лишняя строка в нём означает «сюда теперь можно писать по-настоящему».
 *
 * ⚠ Проверяем ПОВЕДЕНИЕ, а не содержимое списка: тест, сверяющий массив с копией того же массива,
 * краснеет на переименовании и молчит на снятии защиты.
 */

/** `assertTestPortal` завершает процесс на отказ — подменяем выход исключением, чтобы увидеть его. */
function decide(hook: string, argv: string[] = []): 'ok' | 'stopped' {
  const exit = process.exit
  const err = console.error
  const warn = console.warn
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- подмена process.exit на время проверки
  ;(process as any).exit = (code?: number) => {
    throw new Error(`exit:${code ?? 0}`)
  }
  console.error = () => {}
  console.warn = () => {}
  try {
    assertTestPortal(hook, argv)
    return 'ok'
  } catch {
    return 'stopped'
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- возврат подменённого выхода
    ;(process as any).exit = exit
    console.error = err
    console.warn = warn
  }
}

describe('живые проверки не уходят на чужой портал', () => {
  it('действующий тест-портал разрешён', () => {
    expect(decide('https://b24-kacdup.bitrix24.by/rest/1/token/')).toBe('ok')
  })

  it('прежний тест-портал разрешён, пока на нём лежат следы прогонов', () => {
    expect(decide('https://b24-hrbvzq.bitrix24.by/rest/1/token/')).toBe('ok')
  })

  it('посторонний портал ОСТАНАВЛИВАЕТ прогон', () => {
    // Несущее утверждение файла. Домен намеренно похож на настоящий: путаница адресов здесь не
    // гипотетическая, а уже случавшаяся — в оболочке жил вебхук прежнего портала.
    expect(decide('https://client-portal.bitrix24.ru/rest/1/token/')).toBe('stopped')
  })

  it('согласие даётся ТОЛЬКО поимённым доменом, а не голым флагом', () => {
    // «Наверное, это тестовый» здесь нет by design: человек обязан написать адрес руками.
    expect(decide('https://client-portal.bitrix24.ru/rest/1/t/', ['--yes-target'])).toBe('stopped')
    expect(decide('https://client-portal.bitrix24.ru/rest/1/t/', ['--yes-target=other.bitrix24.ru'])).toBe('stopped')
    expect(decide('https://client-portal.bitrix24.ru/rest/1/t/', ['--yes-target=client-portal.bitrix24.ru'])).toBe('ok')
  })

  it('неразбираемый адрес останавливает прогон, а не проскакивает', () => {
    expect(decide('не адрес')).toBe('stopped')
    expect(decide('')).toBe('stopped')
  })
})
