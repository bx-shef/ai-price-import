import { describe, expect, it, vi } from 'vitest'
import {
  MAX_CHAT_REASON,
  bbToPlainText,
  buildErrorMessage,
  buildSuccessMessage,
  entityChatLink,
  entityLink,
  neutralizeBb,
  sendChatMessage
} from '../server/utils/chatNotify'
import { describeTotalMismatch } from '../app/utils/pricing'

describe('neutralizeBb', () => {
  it('folds BB brackets to fullwidth (blocks [url]/mentions injection)', () => {
    expect(neutralizeBb('[url=x]click[/url]')).toBe('［url=x］click［/url］')
    expect(neutralizeBb('plain')).toBe('plain')
  })
  it('tolerates null/undefined', () => {
    expect(neutralizeBb(undefined as unknown as string)).toBe('')
  })
})

describe('entityLink', () => {
  it('maps deal/quote to detail paths, others to universal type path', () => {
    expect(entityLink(1, 4)).toBe('/crm/lead/details/4/') // #135
    expect(entityLink(2, 5)).toBe('/crm/deal/details/5/')
    expect(entityLink(7, 9)).toBe('/crm/quote/show/9/')
    expect(entityLink(1032, 3)).toBe('/crm/type/1032/details/3/')
  })
})

describe('entityChatLink', () => {
  it('builds an ABSOLUTE clickable BB-link when the portal host is known', () => {
    expect(entityChatLink(2, 31, 'bel.bitrix24.by')).toBe('[URL=https://bel.bitrix24.by/crm/deal/details/31/]Открыть в CRM[/URL]')
  })
  it('normalises a scheme/path off the passed domain', () => {
    expect(entityChatLink(2, 31, 'https://bel.bitrix24.by/')).toBe('[URL=https://bel.bitrix24.by/crm/deal/details/31/]Открыть в CRM[/URL]')
  })
  it('emits NO link when the host is unknown or substituted (#385)', () => {
    // Раньше здесь был портало-ОТНОСИТЕЛЬНЫЙ `[URL=/crm/…]`, защищённый доводом «уйти с портала не
    // может». Но вопрос не куда ведёт, а ведёт ли куда-нибудь: в настольном и мобильном клиенте у
    // относительного адреса нет базы, и ссылка мертва. Правило теперь одно на все сообщения.
    expect(entityChatLink(2, 31)).toBeNull()
    expect(entityChatLink(2, 31, 'bel.bitrix24.by@evil.com')).toBeNull()
    expect(entityChatLink(2, 31, 'evil.com')).toBeNull()
  })
})

describe('buildSuccessMessage', () => {
  it('neutralises supplier + warnings and appends the entity link', () => {
    const msg = buildSuccessMessage({
      supplierName: 'ООО [url=evil]Ромашка[/url]',
      entityTypeId: 2,
      entityId: 5,
      created: true,
      rowCount: 3,
      warnings: ['Поставщик не найден']
    })
    expect(msg).toContain('✅ Импортирован документ')
    expect(msg).not.toContain('[url=evil]')
    expect(msg).toContain('Позиций: 3')
    // Хост не передан ⇒ строки со ссылкой в сообщении нет вовсе (#385): «Открыть в CRM», которое
    // ничего не открывает, читается как поломка приложения, а её отсутствие — просто как более
    // короткое сообщение.
    expect(msg).not.toContain('Открыть в CRM')
  })
  it('emits an absolute clickable link when a portal domain is supplied', () => {
    const msg = buildSuccessMessage({ entityTypeId: 2, entityId: 5, created: true, rowCount: 1, warnings: [] }, 'bel.bitrix24.by')
    expect(msg).toContain('[URL=https://bel.bitrix24.by/crm/deal/details/5/]Открыть в CRM[/URL]')
  })
  it('marks an already-imported (not created) document', () => {
    const msg = buildSuccessMessage({ entityTypeId: 2, entityId: 1, created: false, rowCount: 0, warnings: [] })
    expect(msg).toContain('уже был импортирован')
  })
  it('omits the warnings block entirely when there are none', () => {
    const msg = buildSuccessMessage({ entityTypeId: 2, entityId: 1, created: true, rowCount: 1, warnings: [] })
    expect(msg).not.toContain('Предупреждения')
  })

  // #337: САМА СБОРКА, а не длина строки. Первая редакция предупреждения о расхождении итога была
  // 261 символ при кэпе 200, и `chatSafeText` срезал её голым `slice` без многоточия — в чат уходило
  // обезглавленное предложение. Тест тогда молчал, потому что проверял текст ДО обрезки. Проверять
  // длину «до» — тот же приём: он держится только на том, что chatSafeText не удлиняет строку,
  // а это нигде не закреплено. Здесь предупреждение идёт через настоящий buildSuccessMessage.
  it('предупреждение о расхождении итога доезжает в чат ЦЕЛИКОМ, вместе с советом', () => {
    const w = describeTotalMismatch(373198, 390344.56, 'RUB')
    const msg = buildSuccessMessage({ entityTypeId: 2, entityId: 5, created: true, rowCount: 9, warnings: [w] })
    // Все три числа — они и есть поисковый ключ для оператора.
    expect(msg).toContain('373 198,00 RUB')
    expect(msg).toContain('390 344,56 RUB')
    expect(msg).toContain('разница 17 146,56 RUB')
    // И хвост с действием — именно он терялся при обрезке.
    expect(msg).toContain('проверьте позиции.')
    // Никакого обрыва на полуслове: строка предупреждения кончается точкой.
    const line = msg.split('\n').find(l => l.startsWith('• Итог документа'))!
    expect(line.endsWith('.')).toBe(true)
  })
  it('caps the warnings block at 10 lines', () => {
    const warnings = Array.from({ length: 15 }, (_, i) => `w${i}`)
    const msg = buildSuccessMessage({ entityTypeId: 2, entityId: 1, created: true, rowCount: 1, warnings })
    expect(msg).toContain('Предупреждения (15)') // header shows the true count
    expect(msg).toContain('• w9')
    expect(msg).not.toContain('• w10') // but only 10 lines rendered
  })
})

describe('buildErrorMessage', () => {
  it('lists messages BB-safely under a header', () => {
    const msg = buildErrorMessage('[b]Ромашка[/b]', ['Валюта XXX отсутствует'])
    expect(msg).toContain('⛔ Импорт не выполнен')
    expect(msg).not.toContain('[b]')
    expect(msg).toContain('• Валюта XXX отсутствует')
  })
  it('caps the message list at 20 lines', () => {
    const messages = Array.from({ length: 25 }, (_, i) => `e${i}`)
    const msg = buildErrorMessage(undefined, messages)
    expect(msg).toContain('• e19')
    expect(msg).not.toContain('• e20')
  })

  // #385: у админа не было ни идентификатора импорта, ни пути в приложение — соседнее сообщение об
  // отказе несло `Задание:` всегда, это не несло ничего, и разница ниоткуда не была видна.
  it('несёт идентификатор задания и ссылку в приложение', () => {
    const msg = buildErrorMessage('Ромашка', ['нет валюты'], {
      jobId: 'job-7',
      appUrl: 'https://acme.bitrix24.by/marketplace/app/1/'
    })
    expect(msg).toContain('Задание: job-7')
    expect(msg).toContain('[URL=https://acme.bitrix24.by/marketplace/app/1/]открыть приложение[/URL]')
  })

  // Мёртвая ссылка обещает путь и никуда не ведёт — ровно тот дефект, с которого #385 начался.
  it('без известного адреса строки со ссылкой нет вовсе', () => {
    const msg = buildErrorMessage('Ромашка', ['нет валюты'], { jobId: 'job-7' })
    expect(msg).toContain('Задание: job-7')
    expect(msg).not.toContain('[URL=')
    expect(msg).not.toContain('открыть приложение')
  })

  // Хвост не должен становиться дырой в обезвреживании: `]` закрыл бы тег раньше времени, и
  // остаток строки отрисовался бы разметкой под нашей подписью.
  it('обезвреживает разметку в адресе и в идентификаторе', () => {
    const msg = buildErrorMessage('Ромашка', ['x'], {
      jobId: 'job]7[URL=https://evil.example]тут[/URL',
      appUrl: 'https://acme.bitrix24.by/x]?[URL=https://evil.example]тут[/URL'
    })
    expect(msg).not.toContain('evil.example]')
    expect(msg).not.toContain('[/URL]тут')
    expect(msg.match(/\[URL=/g) ?? []).toHaveLength(1)
  })

  // Пустой хвост не печатается: «Задание: » и голая подпись без адреса — мусор, а не сведения.
  it('пустые значения хвоста не печатаются', () => {
    const msg = buildErrorMessage('Ромашка', ['x'], { jobId: '', appUrl: null })
    expect(msg).not.toContain('Задание')
    expect(msg).not.toContain('открыть приложение')
  })
})

describe('sendChatMessage', () => {
  it('calls im.message.add with URL_PREVIEW off and returns the id', async () => {
    const call = vi.fn(async () => 7307)
    const id = await sendChatMessage('chat55', 'hi', call)
    expect(id).toBe(7307)
    expect(call).toHaveBeenCalledWith('im.message.add', { DIALOG_ID: 'chat55', MESSAGE: 'hi', URL_PREVIEW: 'N' })
  })
  it('no-ops on empty dialog or message', async () => {
    const call = vi.fn(async () => 1)
    expect(await sendChatMessage('', 'hi', call)).toBeNull()
    expect(await sendChatMessage('chat1', '   ', call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
  it('returns null on a non-numeric result', async () => {
    const call = vi.fn(async () => ({} as unknown))
    expect(await sendChatMessage('chat1', 'hi', call)).toBeNull()
  })
})

// Сообщения crm-sync несут внешний текст из самого документа (имя поставщика, предупреждения).
// Раньше они проходили только через neutralizeBb — то есть без защиты от голых ссылок, переводов
// строк и внутренних путей, хотя ровно эти дыры уже были закрыты в сообщениях об отказе.
describe('внешний текст в сообщениях crm-sync обезврежен', () => {
  it('голая ссылка в имени поставщика не становится ссылкой', () => {
    const msg = buildErrorMessage('ООО оплатите тут https://evil.example/pay', ['нет валюты'])
    expect(msg).not.toContain('https://')
    expect(msg).toContain('ООО оплатите тут')
  })

  it('www без схемы тоже глушится', () => {
    expect(buildErrorMessage('www.evil.example', ['x'])).not.toContain('www.evil')
  })

  it('переводы строк не дают подделать структуру сообщения', () => {
    const msg = buildErrorMessage('Ромашка', ['цена\n>> Импорт успешен\n------'])
    expect(msg.split('\n').filter(l => l.startsWith('>>'))).toEqual([])
  })

  it('внутренние пути инструментов не уезжают в чат', () => {
    const msg = buildErrorMessage('Ромашка', ['pdftotext: /srv/uploads/member42/job-7.pdf сломан'])
    expect(msg).not.toContain('/srv/uploads')
    expect(msg).toContain('<путь>')
  })

  it('длина внешних полей ограничена', () => {
    const msg = buildErrorMessage('П'.repeat(500), ['п'.repeat(500)])
    for (const line of msg.split('\n')) expect(line.length).toBeLessThan(MAX_CHAT_REASON + 10)
  })

  it('те же гарды в сообщении об успехе', () => {
    const msg = buildSuccessMessage({
      supplierName: 'ООО www.evil.example',
      entityTypeId: 2, entityId: 1, created: true, rowCount: 1,
      warnings: ['смотри /srv/uploads/member42/job-7.pdf']
    })
    expect(msg).not.toContain('www.evil')
    expect(msg).not.toContain('/srv/uploads')
  })
})

// Текст для внешнего канала уведомления (почта, пуш) — без BB-разметки.
//
// ЗАЧЕМ. `im.notify.system.add` принимает `MESSAGE` (BB поддерживается — так сказано в документации
// метода) и `MESSAGE_OUT` — «текст уведомления для внешних каналов, например, почты». Пока второе не
// задано, портал берёт для письма сам `MESSAGE`, и человек читает буквальное
// `[URL=https://…]открыть приложение[/URL]`. Раньше поле не заполнялось, и весь путь числился в
// карте как «никем не проверенный».
describe('bbToPlainText: текст уведомления для внешнего канала', () => {
  it('ссылка превращается в подпись с адресом, а не теряется', () => {
    // Письмо без адреса бесполезно, а «открыть приложение» без ссылки — обещание без выхода.
    expect(bbToPlainText('Можно поправить: [URL=https://p.bitrix24.by/app/1/]открыть приложение[/URL]'))
      .toBe('Можно поправить: открыть приложение: https://p.bitrix24.by/app/1/')
  })

  it('ссылка без подписи печатается адресом', () => {
    expect(bbToPlainText('[URL=https://example.com][/URL]')).toBe('https://example.com')
  })

  it('прочие теги снимаются, содержимое остаётся', () => {
    expect(bbToPlainText('[B]Импорт[/B] не удался')).toBe('Импорт не удался')
  })

  it('⚠ ОБЕЗВРЕЖЕННЫЙ внешний текст не восстанавливается в разметку', () => {
    // Несущая проверка. Имя файла и причина проходят `neutralizeBb` и несут ПОЛНОШИРИННЫЕ ［］.
    // Сними их заодно с нашими — и ссылка из чужого документа ожила бы ровно в том канале, где её
    // никто не смотрит. Снимаем только настоящие скобки, то есть свою разметку.
    const external = neutralizeBb('［URL=https://evil.example］оплатите тут［/URL］')
    const message = `⛔ не удалось внести «${external}».`
    expect(bbToPlainText(message)).toContain('［URL=')
    expect(bbToPlainText(message)).not.toContain('[URL=')
  })

  it('обычный текст не меняется', () => {
    expect(bbToPlainText('Не удалось прочитать файл — возможно, он повреждён.'))
      .toBe('Не удалось прочитать файл — возможно, он повреждён.')
  })

  it('незакрытый тег не съедает адрес вместе с разметкой', () => {
    // Общее правило чистки тегов принимало `[URL=адрес]` без пары за одиночный тег и выбрасывало
    // его целиком — вместе с адресом. Документация функции при этом обещала обратное. Вживую не
    // воспроизводилось (наш сборщик шлёт только парные), но обещание в комментарии, которого код
    // не выполняет, хуже отсутствия комментария.
    const out = bbToPlainText('Текст [URL=https://a.example]откройте это')
    // Утверждается ровно инвариант: адрес уцелел, разметки не осталось. Точный пробел вокруг
    // склейки не фиксируем — на битой разметке аккуратность вывода не то, что мы обещаем.
    expect(out, 'адрес выброшен вместе с разметкой').toContain('https://a.example')
    expect(out, 'разметка осталась в тексте письма').not.toContain('[URL=')
    expect(out).toContain('откройте это')
  })
})

describe('bbToPlainText: у функции РОВНО ОДИН вызывающий вне тестов', () => {
  it('новый вызывающий обязан пройти ревью, а не проскользнуть импортом', () => {
    // ⚠ Гард, а не обещание в комментарии. Функция НЕ санитайзер: на сырой чужой строке она СОБЕРЁТ
    // угрозу — `[URL=https://evil]Оплатите здесь[/URL]` превратится в «Оплатите здесь: https://evil»,
    // то есть в чистый текст, который почтовые и пуш-клиенты автолинкуют сами. Это убедительнее
    // сырых скобок, ради которых и живёт `neutralizeBb`. Безопасно ровно потому, что единственный
    // вызывающий получает уже собранное и обезвреженное сообщение; второй вызывающий на несанированном
    // входе воскресил бы ровно тот фишинг, от которого защищались.
    const { readdirSync, readFileSync, statSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const root = new URL('..', import.meta.url).pathname
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git' || name === 'legacy') continue
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|vue|mjs)$/.test(name)) continue
        if (full.includes(`${root}tests`)) continue
        const src = readFileSync(full, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
        // Само объявление не считаем — ищем ВЫЗОВЫ.
        if (/(?<!function )bbToPlainText\(/.test(src)) callers.push(full.slice(root.length))
      }
    }
    walk(join(root, 'server'))
    walk(join(root, 'app'))
    walk(join(root, 'scripts'))
    expect(callers, `вызывающих стало ${callers.length}: ${callers.join(', ')}`)
      .toEqual(['server/queue/liveDeps.ts'])
  })
})
