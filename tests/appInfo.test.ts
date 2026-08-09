import { describe, expect, it, vi } from 'vitest'
import { fetchAppId } from '../server/utils/appInfo'

// #385, живая находка владельца 09.08.2026. Ссылка «открыть приложение» строилась по СИМВОЛЬНОМУ
// коду карточки Маркета (`/marketplace/view/shef.priceimport/`) — на портале такой адрес не
// открывается. Работает числовой `/marketplace/app/<ID>/`, где `ID` — локальный идентификатор
// установки, свой на каждом портале; отдаёт его `app.info`.

describe('#385: локальный идентификатор приложения на портале', () => {
  it('читается из app.info', async () => {
    const call = vi.fn(async () => ({ ID: 1, CODE: 'x', STATUS: 'L' }))
    expect(await fetchAppId(call as never)).toBe(1)
    expect(call).toHaveBeenCalledWith('app.info', {})
  })

  it('строковое значение портала приводится к числу', async () => {
    // Портал отдаёт `ID` то числом, то строкой — на этом обжигались и в другом месте
    // (`todo.add` вернул объект вместо числа, и маркер молча не писался).
    expect(await fetchAppId((async () => ({ ID: '42' })) as never)).toBe(42)
  })

  it('негодное значение → null, а не адрес, ведущий в никуда', async () => {
    for (const bad of [0, -1, 1.5, 'abc', null, undefined, {}]) {
      expect(await fetchAppId((async () => ({ ID: bad })) as never), String(bad)).toBeNull()
    }
    expect(await fetchAppId((async () => null) as never)).toBeNull()
  })

  it('отказ портала НЕ бросает — уведомление важнее ссылки', async () => {
    // Метод отвечает только в контексте приложения: вебхуком это `ACCESS_DENIED`. Сообщение о
    // неудачном импорте обязано доехать и без ссылки — иначе отказ ссылки глушил бы сам отказ.
    const call = vi.fn(async () => {
      throw new Error('ACCESS_DENIED: Application context required')
    })
    await expect(fetchAppId(call as never)).resolves.toBeNull()
  })
})
