import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { llmDisplayName } from '../app/config/llmDisplay'
import { resolveLlmConfig } from '../server/agent/llmConfig'

// #437. Предупреждение перед загрузкой называло ОБА возможных провайдера и обе юрисдикции, включая
// «при недоступности основного канала — в КНР». Этот сценарий в коде не наступает: автоматического
// переключения нет, `resolveLlmConfig` зовётся один раз на старте, и чтобы данные ушли резервному
// провайдеру, владелец должен сам поменять переменную окружения и перезапустить сервис. То есть за
// предупреждение о том, чего мы не делаем, платили конверсией.

describe('#437: текст называет работающего провайдера, а не список возможных', () => {
  it('название следует за конфигурацией без правки разметки', () => {
    // Несущее утверждение приёмки: переключение `LLM_PROVIDER` меняет текст.
    const bitrix = llmDisplayName(resolveLlmConfig({ LLM_PROVIDER: 'bitrixgpt' }).label)
    const deep = llmDisplayName(resolveLlmConfig({ LLM_PROVIDER: 'deepseek' }).label)
    expect(bitrix.name).toBe('BitrixGPT')
    expect(deep.name).toBe('DeepSeek')
    expect(bitrix.name).not.toBe(deep.name)
  })

  it('техническая метка на страницу не попадает', () => {
    // ⚠ `label` — для журналов и телеметрии. «bitrixgpt» строчными в тексте для посетителя читается
    // как имя переменной, а не как название сервиса.
    for (const p of ['bitrixgpt', 'deepseek']) {
      expect(llmDisplayName(p).name).not.toBe(p)
    }
  })

  it('неизвестный провайдер не печатается как есть', () => {
    // ⚠ В инсталляции клиента (`custom`) значение задаёт владелец инсталляции — оно попало бы на
    // страницу непроверенным. Обобщённое название честно и ничего не выдумывает.
    expect(llmDisplayName('custom').name).toBe('ИИ-сервис')
    expect(llmDisplayName('<script>').name).toBe('ИИ-сервис')
    expect(llmDisplayName(undefined).name).toBe('ИИ-сервис')
  })

  it('версии моделей в витринные названия не попали', () => {
    // ⚠ Обе версии перекрываются переменными окружения — на проде может работать не та, что названа
    // на странице, и расхождение никак себя не проявит. Называем СЕРВИС.
    const src = readFileSync(new URL('../app/config/llmDisplay.ts', import.meta.url), 'utf8')
      .replace(/\/\/.*$/gm, '')
    for (const v of ['5.5', 'v4-flash', 'bitrix/']) expect(src).not.toContain(v)
  })

  it('в предупреждении нет обещания «не используется для обучения» и нет географии', () => {
    // ⚠ Граница, которую переходить нельзя: по условиям BitrixGPT правообладатель ВПРАВЕ обучать на
    // переданных запросах (п. 3.10 Политики). «Мы не сохраняем» — правда; «никто не использует» —
    // ложь, и проверяется она первой. География и «резервный провайдер» уехали в Политику, на
    // которую текст ссылается: в коротком тексте перед кнопкой им не место.
    const vue = readFileSync(new URL('../app/components/DemoTryout.vue', import.meta.url), 'utf8')
    const markup = vue.slice(vue.indexOf('<template>')).replace(/<!--[\s\S]*?-->/g, '')
    for (const banned of ['КНР', 'Россия', 'резервн', 'для обучения', 'не обучаем']) {
      expect(markup, `в предупреждении осталось «${banned}»`).not.toContain(banned)
    }
    // А ссылка на Политику стоит именно там, где принимается решение.
    expect(markup).toContain('/privacy')
  })
})
