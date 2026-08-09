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
// адрес вёл не туда. Ровно этот класс ударил ВТОРОЙ раз (владелец, живой портал 09.08.2026): первая
// починка перевела адрес на домен портала, но выбрала СИМВОЛЬНУЮ форму `/marketplace/view/<код>/`,
// а она на портале не открывается — работает числовая `/marketplace/app/<ID>/` с локальным
// идентификатором установки. Символьный код принадлежит карточке МАРКЕТА, и пока приложение не
// опубликовано, такого адреса не существует вовсе.
//
// Поэтому гарды ниже бьют не по «функция что-то вернула», а по тому, что единственно и отличает
// рабочий адрес от нерабочего: чей это хост, какая это страница и что происходит при неизвестных
// данных.

describe('#385: ссылка «открыть приложение» ведёт в портал', () => {
  it('строится от домена ПОРТАЛА, а не от нашего хоста', () => {
    expect(portalAppUrl('b24-hrbvzq.bitrix24.by', 1))
      .toBe('https://b24-hrbvzq.bitrix24.by/marketplace/app/1/')
  })

  it('адресует УСТАНОВКУ по числовому id, а не карточку Маркета по коду', () => {
    // Три соседние страницы, перепутать которые легко и незаметно:
    //   `/marketplace/detail/<code>/` — листинг Маркета, куда ведёт попап оценки (и это правильно);
    //   `/marketplace/view/<code>/`   — НЕ РАБОТАЕТ на портале (проверено вживую 09.08.2026);
    //   `/marketplace/app/<ID>/`      — само установленное приложение.
    const app = portalAppUrl('x.bitrix24.by', 5)!
    expect(app).toContain('/marketplace/app/5/')
    expect(app).not.toContain('/marketplace/view/')
    expect(app).not.toContain('/marketplace/detail/')
    // Символьный код в этом адресе не участвует вовсе — иначе он вернулся бы туда незаметно.
    expect(app).not.toContain(LANDING_MARKET_CODE)
    expect(marketDetailPath(LANDING_MARKET_CODE)).toContain('/marketplace/detail/')
  })

  it('неизвестный домен или id → ссылки НЕТ, а не битая ссылка', () => {
    // Приёмка issue: «портал, на котором домен неизвестен, получает текст без ссылки … а не битую
    // ссылку». Битая обещает путь назад и никуда не ведёт — это хуже, чем её отсутствие.
    for (const bad of [undefined, null, '', '   ']) {
      expect(portalAppUrl(bad, 1), String(bad)).toBeNull()
    }
    // ⚠ Идентификатор проверяется как целое положительное: `0`, дробь и мусор дали бы адрес, который
    // выглядит рабочим и ведёт в никуда. Портал отдаёт его то числом, то строкой.
    for (const bad of [undefined, null, 0, -3, 1.5, Number.NaN]) {
      expect(portalAppUrl('x.bitrix24.by', bad as number), String(bad)).toBeNull()
    }
    expect(portalAppUrl('x.bitrix24.by', '7' as unknown as number)).toBe('https://x.bitrix24.by/marketplace/app/7/')
  })

  it('домен принимается в любом написании — схема, путь и регистр снимаются', () => {
    // Значение приходит из `portal_tokens.domain`, а туда оно попадает из события портала: там
    // встречается и голый хост, и полный URL. Тот же разбор, что у `entityChatLink`.
    const want = 'https://x.bitrix24.by/marketplace/app/2/'
    for (const d of ['x.bitrix24.by', 'https://x.bitrix24.by', 'https://X.bitrix24.by/', 'http://x.bitrix24.by/crm/']) {
      expect(portalAppUrl(d, 2), d).toBe(want)
    }
  })

  it('чужой хост отвергается, а не подставляется в ссылку', () => {
    // Подпись ссылки фиксированная («открыть приложение»), поэтому подменённый хост читателю не
    // виден — а кликают по ней ровно тогда, когда человеку сказали «импорт не удался». Разбор
    // показал: первая версия принимала всё это. `evil.com` ловится ТОЛЬКО вторым слоем (разбор
    // `new URL` его пропускает — это законный хост), остальное — первым.
    for (const bad of ['x.bitrix24.by@evil.com', 'evil.com', 'javascript:alert(1)', 'x]злая[URL=https://evil.com', '//evil.com']) {
      expect(portalAppUrl(bad, 1), bad).toBeNull()
    }
    // А это не подмена, а формы записи того же портала: порт и ведущие пробелы снимаются.
    expect(portalAppUrl('x.bitrix24.by:8080', 1)).toBe('https://x.bitrix24.by/marketplace/app/1/')
    expect(portalAppUrl('  https://x.bitrix24.by', 1)).toBe('https://x.bitrix24.by/marketplace/app/1/')
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
