import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BOT_AVATAR_BASE64 } from '../server/utils/botAvatar'
import { buildBotProfileUpdate, buildBotRegister } from '../server/utils/chatBot'

// #298. Аватар бота — не отдельная картинка, а ТОТ ЖЕ рендер, что и иконка вкладки: приложение в
// Маркете, вкладка браузера и бот в чате обязаны выглядеть одним продуктом. Отсюда и гард: правка
// логотипа без `pnpm icons` иначе оставила бы бота со старым лицом навсегда — регистрация профиль
// НЕ перезаписывает, а сравнить глазами байты в base64 невозможно.
//
// Не по времени файла: git его не хранит, на свежем клоне (каждый прогон CI) всё одинаково «новое».
const ICON = new URL('../public/icon-192.png', import.meta.url).pathname

describe('аватар чат-бота (#298)', () => {
  it('совпадает байт-в-байт с иконкой приложения', () => {
    expect(BOT_AVATAR_BASE64).toBe(readFileSync(ICON).toString('base64'))
  })

  it('это PNG и без префикса data:', () => {
    // Битрикс ждёт голый base64; префикс `data:image/png;base64,` он не снимает — картинка молча
    // не принялась бы, а вызов best-effort и промолчал бы вместе с ней.
    expect(BOT_AVATAR_BASE64.startsWith('data:')).toBe(false)
    const bytes = Buffer.from(BOT_AVATAR_BASE64, 'base64')
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    // Ширина и высота из заголовка IHDR — предел портала 5000×5000.
    expect(bytes.readUInt32BE(16)).toBe(192)
    expect(bytes.readUInt32BE(20)).toBe(192)
  })

  it('уходит ТОЛЬКО в обновлении профиля, не в регистрации', () => {
    // Портал вправе отвергнуть картинку (BOT_AVATAR_INCORRECT_TYPE/SIZE). Внутри регистрации это
    // уронило бы весь вызов: бота нет вовсе, и сообщения снова подписаны именем сотрудника —
    // заметно хуже, чем бот с картинкой по умолчанию.
    const register = JSON.stringify(buildBotRegister())
    expect(register).not.toContain('avatar')

    const update = buildBotProfileUpdate(42)
    const props = (update!.params.fields as { properties: Record<string, unknown> }).properties
    expect(props.avatar).toBe(BOT_AVATAR_BASE64)
    // Имя и должность не потерялись рядом с картинкой.
    expect(props.name).toBeTruthy()
  })
})
