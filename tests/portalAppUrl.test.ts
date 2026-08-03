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

  it('чужой хост отвергается, а не подставляется в ссылку', () => {
    // Подпись ссылки фиксированная («открыть приложение»), поэтому подменённый хост читателю не
    // виден — а кликают по ней ровно тогда, когда человеку сказали «импорт не удался». Разбор
    // показал: первая версия принимала всё это. `evil.com` ловится ТОЛЬКО вторым слоем (разбор
    // `new URL` его пропускает — это законный хост), остальное — первым.
    for (const bad of ['x.bitrix24.by@evil.com', 'evil.com', 'javascript:alert(1)', 'x]злая[URL=https://evil.com', '//evil.com']) {
      expect(portalAppUrl(bad, 'c'), bad).toBeNull()
    }
    // А это не подмена, а формы записи того же портала: порт и ведущие пробелы снимаются.
    expect(portalAppUrl('x.bitrix24.by:8080', 'c')).toBe('https://x.bitrix24.by/marketplace/view/c/')
    expect(portalAppUrl('  https://x.bitrix24.by', 'c')).toBe('https://x.bitrix24.by/marketplace/view/c/')
  })

  it('наш собственный хост больше не участвует в этом пути — НИГДЕ в проводке', () => {
    // ⚠ Прежний гард резал 400 знаков от имени функции и потому сторожил её ТЕЛО, а регрессия
    // живёт на МЕСТЕ ВЫЗОВА: мутация `appUrl: … ?? \`${NUXT_PUBLIC_SITE_URL}/app\`` проходила при
    // пяти зелёных тестах — то есть тупиковая ссылка возвращалась на каждом портале с пустым
    // доменом. Плюс любое переименование функции давало ложный красный. Теперь — весь файл.
    const live = readFileSync(new URL('../server/queue/liveDeps.ts', import.meta.url), 'utf8')
    expect(live).toContain('portalAppUrl')
    expect(live).not.toContain('NUXT_PUBLIC_SITE_URL')
  })
})
