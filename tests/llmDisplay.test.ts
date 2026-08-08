import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { llmDisplayName } from '../app/config/llmDisplay'
import { resolveLlmConfig } from '../server/agent/llmConfig'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

// #437. Предупреждение перед загрузкой называло ОБА возможных провайдера и обе юрисдикции, включая
// «при недоступности основного канала — в КНР». Этот сценарий в коде не наступает: автоматического
// переключения нет, `resolveLlmConfig` зовётся один раз на старте, и чтобы данные ушли резервному
// провайдеру, владелец должен сам поменять переменную окружения и перезапустить сервис. То есть за
// предупреждение о том, чего мы не делаем, платили конверсией.

describe('#437: текст называет работающего провайдера, а не список возможных', () => {
  it('название следует за конфигурацией без правки разметки', () => {
    // Несущее утверждение приёмки: переключение `LLM_PROVIDER` меняет текст.
    const bitrix = llmDisplayName(resolveLlmConfig({ LLM_PROVIDER: 'bitrixgpt' }).provider)
    const deep = llmDisplayName(resolveLlmConfig({ LLM_PROVIDER: 'deepseek' }).provider)
    expect(bitrix.name).toBe('BitrixGPT')
    expect(deep.name).toBe('DeepSeek')
    expect(bitrix.name).not.toBe(deep.name)
  })

  it('техническая метка на страницу не попадает', () => {
    // ⚠ `label` — для журналов и телеметрии. «bitrixgpt» строчными в тексте для посетителя читается
    // как имя переменной, а не как название сервиса.
    for (const p of ['bitrixgpt', 'deepseek'] as const) {
      expect(llmDisplayName(p).name).not.toBe(p)
    }
  })

  it('неизвестный провайдер не печатается как есть', () => {
    // ⚠ В инсталляции клиента (`custom`) получателя выбирает её владелец — назвать его за него мы
    // не можем. «Внешний провайдер» честно и ничего не выдумывает.
    expect(llmDisplayName('custom' as never).name).toBe('внешний провайдер')
    expect(llmDisplayName(undefined).name).toBe('внешний провайдер')
  })

  it('роут отдаёт ТОЛЬКО витринное имя — ни ключа, ни адреса, ни версии', () => {
    // ⚠ Роут не был покрыт вовсе: мутация «вернуть `label` и `baseURL`» проходила при всех зелёных
    // тестах, то есть наружу уходили техническая метка и адрес провайдера — ровно то, что запрещает
    // комментарий в самом файле.
    const src = read('../server/api/demo/provider.get.ts').replace(/\/\/.*$/gm, '')
    expect(src, 'роут ключуется по метке, а не по провайдеру').toContain('resolveLlmConfig(process.env).provider')
    for (const leak of ['apiKey', 'baseURL', 'model', '.label']) {
      expect(src, `роут отдаёт наружу ${leak}`).not.toContain(leak)
    }
  })

  it('баннер ДЕЙСТВИТЕЛЬНО печатает имя работающего сервиса и берёт его с сервера', () => {
    // ⚠ Позитивная проверка. Прежняя была только чёрным списком запрещённых слов, поэтому мутация
    // «убрать имя из разметки» (баннер снова без названия) проходила зелёной — то есть несущее
    // утверждение задачи «текст следует за конфигурацией» до интерфейса не доводилось.
    const vue = read('../app/components/DemoTryout.vue')
    expect(vue).toContain('/api/demo/provider')
    expect(vue.slice(vue.indexOf('<template>'))).toContain('providerSuffix')
  })

  it('версии моделей в витринные названия не попали', () => {
    // ⚠ Обе версии перекрываются переменными окружения — на проде может работать не та, что названа
    // на странице, и расхождение никак себя не проявит. Называем СЕРВИС.
    const src = read('../app/config/llmDisplay.ts').replace(/\/\/.*$/gm, '')
    for (const v of ['5.5', 'v4-flash', 'bitrix/']) expect(src).not.toContain(v)
  })

  it('в предупреждении нет обещания «не используется для обучения» и нет географии', () => {
    // ⚠ Граница, которую переходить нельзя: по условиям BitrixGPT правообладатель ВПРАВЕ обучать на
    // переданных запросах (п. 3.10 Политики). «Мы не сохраняем» — правда; «никто не использует» —
    // ложь, и проверяется она первой. География и «резервный провайдер» уехали в Политику, на
    // которую текст ссылается: в коротком тексте перед кнопкой им не место.
    const vue = read('../app/components/DemoTryout.vue')
    const markup = vue.slice(vue.indexOf('<template>')).replace(/<!--[\s\S]*?-->/g, '')
    // ⚠ Обещание про обучение — ЧЁРНЫЙ список, и это осознанно: запретить надо конкретные
    // формулировки, а перечислить все допустимые нельзя.
    for (const banned of ['для обучения', 'не обучаем', 'не используются для']) {
      expect(markup, `в предупреждении осталось «${banned}»`).not.toContain(banned)
    }
    // ⚠ А вот география чёрным списком НЕ проверяется: «обработка в Китае» вместо «КНР» прошла бы
    // мимо любого перечня. Проверяем позитивно — юрисдикция приходит из одного места (`llmDisplay`),
    // и в разметке её нет вовсе, поэтому вернуть её туда «мимо» нельзя.
    const geo = read('../app/components/DemoTryout.vue')
    const markupOnly = geo.slice(geo.indexOf('<template>')).replace(/<!--[\s\S]*?-->/g, '')
    expect(markupOnly, 'юрисдикция вписана в разметку вручную').not.toMatch(/Росси|Кита|КНР/)
    // ⚠ Ссылка — на Политику САЙТА: посетитель демо приложение не устанавливал, и Политика
    // приложения сама себя из этой области исключает (её п. 1.1). Демо-разбор расписан в
    // `docs/site-privacy.md` §4.
    expect(markup).toContain('/site-privacy')
  })
})
