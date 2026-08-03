import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { marketDetailPath, portalAppUrl } from '../app/config/b24'
import { LANDING_MARKET_CODE } from '../app/utils/landing'

// #385. Сообщение о неудачном импорте обещало путь назад — «Можно поправить и загрузить снова:
// открыть приложение» — и приводило в тупик: адрес собирался от НАШЕГО хоста
// (`NUXT_PUBLIC_SITE_URL + '/app'`). Открытый вне портала, он не даёт ни фрейма, ни фрейм-токена,
// ни `member_id`, и человек видел «доступно только внутри портала Bitrix24».
//
// Класс ошибки важнее самой ошибки: строка собиралась без исключений, тест на неё был зелёный, а
// адрес вёл не туда. Поэтому гарды ниже бьют не по «функция что-то вернула», а по трём вещам,
// которые единственные и отличают рабочий адрес от нерабочего: чей это хост, какая это страница
// Маркета и что происходит, когда хост неизвестен.

describe('#385: ссылка «открыть приложение» ведёт в портал', () => {
  it('строится от домена ПОРТАЛА, а не от нашего хоста', () => {
    expect(portalAppUrl('b24-hrbvzq.bitrix24.by', 'shef.priceimport'))
      .toBe('https://b24-hrbvzq.bitrix24.by/marketplace/view/shef.priceimport/')
  })

  it('ведёт на САМО приложение, а не на карточку в Маркете', () => {
    // Две соседние страницы, перепутать которые легко и незаметно: `/marketplace/detail/<code>/` —
    // листинг, куда ведёт попап оценки (и это правильно), `/marketplace/view/<code>/` — приложение.
    const app = portalAppUrl('x.bitrix24.by', LANDING_MARKET_CODE)!
    expect(app).toContain('/marketplace/view/')
    expect(app).not.toContain('/marketplace/detail/')
    expect(marketDetailPath(LANDING_MARKET_CODE)).toContain('/marketplace/detail/')
  })

  it('неизвестный домен или код → ссылки НЕТ, а не битая ссылка', () => {
    // Приёмка issue: «портал, на котором домен неизвестен, получает текст без ссылки … а не битую
    // ссылку». Битая обещает путь назад и никуда не ведёт — это хуже, чем её отсутствие.
    for (const bad of [undefined, null, '', '   ']) {
      expect(portalAppUrl(bad, LANDING_MARKET_CODE), String(bad)).toBeNull()
    }
    expect(portalAppUrl('x.bitrix24.by', '  ')).toBeNull()
  })

  it('домен принимается в любом написании — схема, путь и регистр снимаются', () => {
    // Значение приходит из `portal_tokens.domain`, а туда оно попадает из события портала: там
    // встречается и голый хост, и полный URL. Тот же разбор, что у `entityChatLink`.
    const want = 'https://x.bitrix24.by/marketplace/view/c/'
    for (const d of ['x.bitrix24.by', 'https://x.bitrix24.by', 'https://X.bitrix24.by/', 'http://x.bitrix24.by/crm/']) {
      expect(portalAppUrl(d, 'c'), d).toBe(want)
    }
  })

  it('наш собственный хост больше не участвует в этом пути', () => {
    // Гард по исходнику: правка «вернуть как было» проходит все проверки выше, если собрать адрес
    // от `NUXT_PUBLIC_SITE_URL` — функция-то останется корректной, её просто перестанут звать.
    const live = readFileSync(new URL('../server/queue/liveDeps.ts', import.meta.url), 'utf8')
    const fn = live.slice(live.indexOf('function appImportUrl'), live.indexOf('function appImportUrl') + 400)
    expect(fn).toContain('portalAppUrl')
    expect(fn).not.toContain('NUXT_PUBLIC_SITE_URL')
  })
})
