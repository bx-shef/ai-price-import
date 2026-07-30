// @vitest-environment nuxt
import { describe, it, expect, beforeEach } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import LoginPage from '~/pages/login.vue'

// #271-M: раньше при выключенном входе поле и кнопка оставались активными — предупреждение висело,
// а форма приглашала набирать пароль, который сервер всё равно не примет. Проверяем ПРОВОДКУ:
// чистый loginErrorMessage покрыт отдельно, здесь важно, что страница им действительно пользуется.

let enabled = true
let loginStatus = 200

registerEndpoint('/api/auth/session', () => ({ authenticated: false, enabled }))
registerEndpoint('/api/auth/login', (event) => {
  if (loginStatus === 200) return { ok: true }
  event.node.res.statusCode = loginStatus
  if (loginStatus === 429) event.node.res.setHeader('Retry-After', '300')
  return { error: 'ответ сервера' }
})

beforeEach(() => {
  enabled = true
  loginStatus = 200
})

/** Ждём, пока страница дорисуется: проверка сессии идёт через сетевой слой. */
const flush = async (w?: { text: () => string }, needle?: string) => {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 10))
    if (!w || !needle || w.text().includes(needle)) return
  }
}

describe('страница входа оператора', () => {
  it('вход выключен — поле и кнопка неактивны, а не только предупреждение', async () => {
    enabled = false
    const w = await mountSuspended(LoginPage)
    await flush(w, 'отключён администратором')
    expect(w.find('input[type="password"]').attributes('disabled')).toBeDefined()
    expect(w.find('button[type="submit"]').attributes('disabled')).toBeDefined()
  })

  it('вход включён — форма рабочая', async () => {
    const w = await mountSuspended(LoginPage)
    await flush(w, 'Пароль')
    expect(w.find('input[type="password"]').attributes('disabled')).toBeUndefined()
  })

  it('перебор — говорим, сколько ждать, и глушим форму', async () => {
    loginStatus = 429
    const w = await mountSuspended(LoginPage)
    await flush(w, 'Пароль')
    await w.find('input[type="password"]').setValue('нет')
    await w.find('form').trigger('submit')
    await flush(w, 'Слишком много попыток')
    expect(w.text()).toContain('через 5 мин')
    // Дальнейшие попытки только продлевали бы окно ожидания.
    expect(w.find('input[type="password"]').attributes('disabled')).toBeDefined()
  })

  it('неверный пароль — так и пишем, форма остаётся рабочей', async () => {
    loginStatus = 401
    const w = await mountSuspended(LoginPage)
    await flush(w, 'Пароль')
    await w.find('input[type="password"]').setValue('нет')
    await w.find('form').trigger('submit')
    await flush(w, 'Неверный пароль')
    expect(w.text()).toContain('Неверный пароль')
    expect(w.find('input[type="password"]').attributes('disabled')).toBeUndefined()
  })
})
