// @vitest-environment nuxt
import { describe, it, expect, beforeEach } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import LoginPage from '~/pages/login.vue'

// #271-M: раньше при выключенном входе поле и кнопка оставались активными — предупреждение висело,
// а форма приглашала набирать пароль, который сервер всё равно не примет. Проверяем ПРОВОДКУ:
// чистые функции покрыты отдельно, здесь важно, что страница ими действительно пользуется.

let enabled = true
let loginStatus = 200
let sendRetryAfter = true

registerEndpoint('/api/auth/session', () => ({ authenticated: false, enabled }))
registerEndpoint('/api/auth/login', (event) => {
  if (loginStatus === 200) return { ok: true }
  event.node.res.statusCode = loginStatus
  if (loginStatus === 429 && sendRetryAfter) event.node.res.setHeader('Retry-After', '300')
  return { error: 'ответ сервера' }
})

beforeEach(() => {
  enabled = true
  loginStatus = 200
  sendRetryAfter = true
})

/** Ждём, пока страница дорисуется. Не дождались — падаем: молчаливый выход прятал бы гонки. */
async function until(w: { text: () => string }, needle: string) {
  for (let i = 0; i < 200; i++) {
    if (w.text().includes(needle)) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`не дождались «${needle}» на странице`)
}

/** Ввести пароль и отправить форму. */
async function trySignIn(w: Awaited<ReturnType<typeof mountSuspended>>) {
  await w.find('input[type="password"]').setValue('пароль')
  await w.find('form').trigger('submit')
}

const isDisabled = (w: Awaited<ReturnType<typeof mountSuspended>>, sel: string) =>
  w.find(sel).attributes('disabled') !== undefined

describe('страница входа оператора', () => {
  it('вход выключен — поле и кнопка неактивны, а не только предупреждение', async () => {
    enabled = false
    const w = await mountSuspended(LoginPage)
    await until(w, 'Вход оператора отключён')
    // Пароль вводим ПЕРЕД проверкой кнопки: иначе её погасило бы пустое поле, и проверка
    // блокировки ничего бы не значила.
    await w.find('input[type="password"]').setValue('пароль')
    expect(isDisabled(w, 'input[type="password"]')).toBe(true)
    expect(isDisabled(w, 'button[type="submit"]')).toBe(true)
    expect(w.text()).toContain('обратитесь к администратору')
  })

  it('выключенный вход не даёт отправить форму даже в обход кнопки', async () => {
    enabled = false
    loginStatus = 401 // если запрос всё-таки уйдёт, увидим сообщение сервера
    const w = await mountSuspended(LoginPage)
    await until(w, 'Вход оператора отключён')
    await trySignIn(w)
    await new Promise(r => setTimeout(r, 60))
    expect(w.text()).not.toContain('Неверный пароль')
  })

  it('до ответа проверки сессии форма НЕ мигает неактивной', async () => {
    enabled = false // выяснится только после ответа
    const w = await mountSuspended(LoginPage)
    // Сразу после монтирования исход ещё неизвестен — гасить нечего.
    expect(isDisabled(w, 'input[type="password"]')).toBe(false)
    await until(w, 'Вход оператора отключён')
    expect(isDisabled(w, 'input[type="password"]')).toBe(true)
  })

  it('вход включён — форма рабочая', async () => {
    const w = await mountSuspended(LoginPage)
    await until(w, 'Пароль')
    expect(isDisabled(w, 'input[type="password"]')).toBe(false)
  })

  it('перебор — говорим, сколько ждать, и гасим только кнопку', async () => {
    loginStatus = 429
    const w = await mountSuspended(LoginPage)
    await until(w, 'Пароль')
    await trySignIn(w)
    await until(w, 'Слишком много попыток')
    expect(w.text()).toContain('через 5 минут')
    // Поле остаётся живым: иначе фокус выпадает и на странице нечего нажать.
    expect(isDisabled(w, 'input[type="password"]')).toBe(false)
    expect(isDisabled(w, 'button[type="submit"]')).toBe(true)
    expect(w.text()).toContain('Повтор через')
  })

  it('429 без Retry-After (так отвечает nginx) — короткий срок, а не «подождите»', async () => {
    loginStatus = 429
    sendRetryAfter = false
    const w = await mountSuspended(LoginPage)
    await until(w, 'Пароль')
    await trySignIn(w)
    await until(w, 'Слишком много попыток')
    expect(w.text()).toContain('через 10 с')
  })

  it('пароль убрали на сервере при открытой странице — форма гаснет, а не зовёт пробовать снова', async () => {
    loginStatus = 503
    const w = await mountSuspended(LoginPage)
    await until(w, 'Пароль')
    await trySignIn(w)
    await until(w, 'Вход выключен')
    expect(isDisabled(w, 'input[type="password"]')).toBe(true)
  })

  it('неверный пароль — так и пишем, форма остаётся рабочей', async () => {
    loginStatus = 401
    const w = await mountSuspended(LoginPage)
    await until(w, 'Пароль')
    await trySignIn(w)
    await until(w, 'Неверный пароль')
    expect(isDisabled(w, 'input[type="password"]')).toBe(false)
    expect(isDisabled(w, 'button[type="submit"]')).toBe(false)
  })
})
