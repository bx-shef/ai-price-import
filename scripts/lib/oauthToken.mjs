// Живой OAuth-токен приложения для скриптов разведки — с САМООБНОВЛЕНИЕМ.
//
// ⚠ Зачем: access-токен Битрикс24 живёт час. Скрипты, читавшие `.env.b24oauth` напрямую, падали с
// `expired_token` посреди прогона — и это выглядело как поломка портала, хотя всё, что требовалось,
// это рефреш. Хуже: витрина успевала создать половину записей и оставляла мусор на портале.
//
// ⚠ Рефреш РОТИРУЕТ пару (Битрикс возвращает новый refresh_token), поэтому новые значения
// записываются обратно в `.env.b24oauth` СРАЗУ. Не записать — значит потерять доступ насовсем:
// прежний refresh уже недействителен, а нового ни у кого нет.
//
// ⚠ Файл переписывается ПОСТРОЧНО, значение за значением: полная перезапись «своим» шаблоном
// стёрла бы строки, которых этот модуль не знает.
import { readFileSync, writeFileSync } from 'node:fs'
import { readEnvValue } from './envFile.mjs'

const FILE = '.env.b24oauth'
const OAUTH_URL = 'https://oauth.bitrix.info/oauth/token/'

/** Переписать значения в env-файле, не трогая остальные строки. */
function patchEnvFile(patch) {
  const lines = readFileSync(FILE, 'utf8').split('\n')
  const out = lines.map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line)
    const key = m?.[1]
    return key && key in patch ? `${key}=${patch[key]}` : line
  })
  writeFileSync(FILE, out.join('\n'))
}

/**
 * Отдать рабочий access-токен: проверяет текущий вызовом `profile` и рефрешит при отказе.
 * Возвращает `{ domain, token }`.
 */
export async function liveOauth() {
  const domain = readEnvValue(FILE, 'B24_OAUTH_DOMAIN')
  let token = readEnvValue(FILE, 'B24_OAUTH_ACCESS_TOKEN')

  // ⚠ Ответ разбирается ЗАЩИЩЁННО и с повтором. Прежняя строка звала `.json()` напрямую, поэтому
  // любой сбой на пути (прокси отдаёт «upstream connect error», шлюз — HTML) валил скрипт с
  // `Unexpected token 'u'` — то есть авария сети читалась как «токен протух». Хуже тихий случай:
  // разберись такой ответ во что-нибудь без `error`, мы сочли бы мёртвый токен живым.
  // Различаем ТРИ исхода, а не два: жив / протух / не смогли определить.
  const probe = async (t) => {
    try {
      const r = await fetch(`https://${domain}/rest/profile.json?auth=${t}`)
      const text = await r.text()
      let j
      try { j = JSON.parse(text) } catch { return 'unknown' }
      if (j.error === 'expired_token' || j.error === 'invalid_token') return 'expired'
      return j.result ? 'alive' : 'unknown'
    } catch { return 'unknown' }
  }

  let verdict = await probe(token)
  if (verdict === 'unknown') {
    await new Promise(r => setTimeout(r, 1500))
    verdict = await probe(token)
  }
  // ⚠ Не смогли определить и со второй попытки — НЕ рефрешим: ротация сожгла бы годный
  // refresh_token из-за чужой аварии. Пусть вызов упадёт своей настоящей ошибкой.
  if (verdict !== 'expired') return { domain, token }

  const refresh = readEnvValue(FILE, 'B24_OAUTH_REFRESH_TOKEN')
  const clientId = readEnvValue(FILE, 'B24_CLIENT_ID')
  const clientSecret = readEnvValue(FILE, 'B24_CLIENT_SECRET')
  if (!refresh || !clientId || !clientSecret) throw new Error(`${FILE}: нет refresh_token или client_id/secret — рефреш невозможен`)

  // Секреты идут ТЕЛОМ POST, а не в query: иначе они осели бы в логах прокси.
  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refresh })
  })
  const j = await res.json()
  if (!j.access_token) throw new Error(`рефреш не удался: ${j.error || 'нет access_token'} ${j.error_description || ''}`)

  token = j.access_token
  patchEnvFile({ B24_OAUTH_ACCESS_TOKEN: j.access_token, B24_OAUTH_REFRESH_TOKEN: j.refresh_token })
  console.log('  токен обновлён и сохранён в .env.b24oauth')
  return { domain, token }
}
