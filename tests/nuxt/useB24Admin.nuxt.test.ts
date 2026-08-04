// @vitest-environment nuxt
import { describe, expect, it, vi } from 'vitest'

// #411. Композабл не был покрыт ничем, и мутационная проверка это доказала: подмены `isAdmin()` на
// «всегда true» и «всегда false» проходили при полностью зелёном наборе. Первая возвращает целиком
// тот дефект, ради которого заведена задача (сотрудник видит кнопку и получает отказ после
// согласия), вторая тихо отбирает функцию у администратора — без единого сообщения на экране.

/** Поднимает свежий модуль с подставленным фреймом портала. */
async function withFrame(auth: unknown) {
  vi.resetModules()
  // Композабл считает себя «во фрейме» по непустому `window.name` — так портал помечает окно.
  window.name = 'test-frame'
  vi.doMock('@bitrix24/b24jssdk', () => ({
    initializeB24Frame: async () => ({ auth })
  }))
  const { useB24 } = await import('~/composables/useB24')
  const b = useB24()
  await b.init()
  return b
}

describe('#411: признак администратора из фрейма', () => {
  it('портал сказал «администратор» — true', async () => {
    const b = await withFrame({ isAdmin: true, getAuthData: () => false })
    expect(b.isAdmin()).toBe(true)
  })

  it('портал сказал «нет» — false', async () => {
    const b = await withFrame({ isAdmin: false, getAuthData: () => false })
    expect(b.isAdmin()).toBe(false)
  })

  it('не булево значение — считаем не-админом', async () => {
    // Строка «N» истинна: проверка «на правдивость» вместо строгой выдала бы права не тому.
    const b = await withFrame({ isAdmin: 'N', getAuthData: () => false })
    expect(b.isAdmin()).toBe(false)
  })

  it('вне портала фрейма нет — false, и ничего не падает', async () => {
    vi.resetModules()
    window.name = ''
    const { useB24 } = await import('~/composables/useB24')
    expect(() => useB24().isAdmin()).not.toThrow()
    expect(useB24().isAdmin()).toBe(false)
  })
})
