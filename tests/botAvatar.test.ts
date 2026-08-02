import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BOT_AVATAR_BASE64 } from '../server/utils/botAvatar'
import { buildBotProfileUpdate, buildBotRegister, pushBotProfile } from '../server/utils/chatBot'

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

  it('иконка и аватар пересобраны из ТЕКУЩЕГО логотипа', () => {
    // Замечание ревью: сверка «аватар === icon-192.png» сравнивала два файла, которые пишет ОДИН
    // и тот же `pnpm icons`. Правка `favicon.svg` без его запуска оставляла оба старыми — и
    // одинаковыми, то есть гард был зелёным, а логотип везде прежним. Поэтому в штампе лежит хэш
    // САМОГО ИСТОЧНИКА: разошёлся — значит генератор не запускали.
    const stamp = JSON.parse(readFileSync(new URL('../public/icons.stamp.json', import.meta.url).pathname, 'utf8'))
    const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
    expect(stamp.source, 'правили public/favicon.svg — запустите `pnpm icons`').toBe(
      sha(readFileSync(new URL('../public/favicon.svg', import.meta.url).pathname, 'utf8'))
    )
    expect(stamp.icon192, 'public/icon-192.png подменён мимо генератора').toBe(sha(readFileSync(ICON)))
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

describe('отказ по картинке не уносит имя бота (#298, замечание ревью)', () => {
  /** Фейковый транспорт: падает, если в параметрах есть аватар. */
  function makeCall(rejectAvatar: boolean) {
    const seen: Array<Record<string, unknown>> = []
    const call = async (_m: string, p: Record<string, unknown>) => {
      seen.push(p)
      const props = (p.fields as { properties: Record<string, unknown> }).properties
      if (rejectAvatar && props.avatar) throw new Error('BOT_AVATAR_INCORRECT_SIZE')
      return {}
    }
    return { seen, get: async () => call as never }
  }

  it('портал отверг картинку — имя и должность всё равно доезжают', async () => {
    // Имя и картинка едут ОДНИМ вызовом, поэтому отказ применял НИЧЕГО. А регистрация профиль не
    // перезаписывает и вызов идёт один раз на установку — бот остался бы безымянным навсегда.
    // Это не «бот с картинкой по умолчанию», это частичный возврат симптома #316.
    const t = makeCall(true)
    await pushBotProfile(7, t.get)
    expect(t.seen).toHaveLength(2)
    const retry = (t.seen[1]!.fields as { properties: Record<string, unknown> }).properties
    expect(retry.avatar).toBeUndefined()
    expect(retry.name).toBeTruthy()
  })

  it('портал принял картинку — второго вызова нет', async () => {
    const t = makeCall(false)
    await pushBotProfile(7, t.get)
    expect(t.seen).toHaveLength(1)
  })

  it('оба вызова упали — молчим, импорт не роняем', async () => {
    const boom = async () => {
      throw new Error('ACCESS_DENIED')
    }
    await expect(pushBotProfile(7, async () => boom as never)).resolves.toBeUndefined()
  })
})
