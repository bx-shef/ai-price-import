import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadLlmEnv } from '../scripts/lib/llmEnv.mjs'

// Загрузчик ключей провайдера для живых скриптов. Он dev-only и в прод-сборку не попадает, но
// прецедент «гард на dev-скрипт живёт в общем прогоне» в проекте уже есть
// (`feedbackTriageValidate`), а держать эти правила прозой в комментариях значит узнавать о
// поломке ровно тогда, когда живая проверка понадобилась. Три мутации ниже тихие: симптом
// появляется в разгар разбора, и выглядит он как отказ провайдера, а не как ошибка скрипта.

// ⚠ `OPERATOR_PASSWORD` в списке не потому, что загрузчик его трогает (он как раз НЕ должен), а
// потому, что его снимает проверка «за пределы списка не выходит»: без восстановления она унесла
// бы настоящее значение из окружения для всех последующих файлов прогона.
const KEYS = ['LLM_PROVIDER', 'DEEPSEEK_API_KEY', 'BITRIXGPT_API_KEY', 'VIBE_API_KEY', 'LLM_MODEL', 'OPERATOR_PASSWORD'] as const
const saved = new Map<string, string | undefined>()
for (const k of KEYS) saved.set(k, process.env[k])

function envFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'llmenv-'))
  const p = join(dir, '.env')
  writeFileSync(p, body)
  return p
}

/** Убрать переменную так, чтобы `process.env[key]` дал `undefined` (а не пустую строку). */
function unsetEnv(key: string): void {
  Reflect.deleteProperty(process.env, key)
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) unsetEnv(k)
    else process.env[k] = v
  }
})

describe('loadLlmEnv', () => {
  it('закомментированная строка не читается', () => {
    // ⚠ Самая тяжёлая из тихих мутаций: без якоря строки `#DEEPSEEK_API_KEY=старый` начинает
    // матчиться и ВЫИГРЫВАЕТ (совпадение ищется одно, первое). Прогон уходит со старым ключом или
    // старым адресом — то есть текст документа отправляется не туда, куда думает оператор, а
    // скрипт при этом выглядит совершенно исправным.
    unsetEnv('DEEPSEEK_API_KEY')
    loadLlmEnv(envFile('#DEEPSEEK_API_KEY=старый\n'))
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined()
  })

  it('ключ как ХВОСТ более длинного имени не подхватывается', () => {
    unsetEnv('DEEPSEEK_API_KEY')
    loadLlmEnv(envFile('EVIL_DEEPSEEK_API_KEY=чужое\n'))
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined()
  })

  it('переменная из окружения ВЫИГРЫВАЕТ у файла', () => {
    // ⚠ Разворот приоритета относительно прежних копий загрузчика, и он намеренный: на сервере,
    // настроенном на bitrixgpt, файл с `deepseek` заставлял живую проверку проверять НЕ ТОГО
    // провайдера, которым работает воркер. Инверсия этого условия возвращает ровно тот дефект.
    process.env.LLM_PROVIDER = 'bitrixgpt'
    loadLlmEnv(envFile('LLM_PROVIDER=deepseek\n'))
    expect(process.env.LLM_PROVIDER).toBe('bitrixgpt')
  })

  it('ПУСТАЯ переменная окружения уступает файлу', () => {
    // ⚠ Проверка на непустоту, а не на «объявлена»: `LLM_PROVIDER=` в окружении контейнера — это
    // «не задано», и уступать ему значило бы остаться без провайдера при заполненном файле.
    process.env.LLM_PROVIDER = ''
    loadLlmEnv(envFile('LLM_PROVIDER=deepseek\n'))
    expect(process.env.LLM_PROVIDER).toBe('deepseek')
  })

  it('за пределы списка ключей не выходит', () => {
    // ⚠ В `.env` рядом лежат вебхук портала, пароль оператора и ключ шифрования токенов. Мутация
    // «копировать весь файл» отдала бы их процессу, который гоняет текст документа во внешнего
    // провайдера, и ни один прогон не покраснел бы.
    unsetEnv('OPERATOR_PASSWORD')
    loadLlmEnv(envFile('OPERATOR_PASSWORD=секрет\nLLM_MODEL=м\n'))
    expect(process.env.OPERATOR_PASSWORD).toBeUndefined()
    expect(process.env.LLM_MODEL).toBe('м')
  })

  it('кавычки снимаются, `export` принимается', () => {
    unsetEnv('LLM_MODEL')
    unsetEnv('BITRIXGPT_API_KEY')
    loadLlmEnv(envFile('LLM_MODEL="в кавычках"\nexport BITRIXGPT_API_KEY=через-export\n'))
    expect(process.env.LLM_MODEL).toBe('в кавычках')
    expect(process.env.BITRIXGPT_API_KEY).toBe('через-export')
  })

  it('хвостовые пробелы и CR срезаются', () => {
    // ⚠ Практический случай — `.env`, поправленный из Windows: значение уезжает с `\r`, ключ
    // провайдера становится недействительным, а скрипт при этом выглядит совершенно исправным и
    // сообщает об отказе авторизации у провайдера. Мутация «убрать trim» иначе проходит молча.
    unsetEnv('LLM_MODEL')
    loadLlmEnv(envFile('LLM_MODEL=модель  \r\nLLM_PROVIDER=deepseek\n'))
    expect(process.env.LLM_MODEL).toBe('модель')
  })

  it('отсутствие файла — не ошибка', () => {
    // На сервере владельца и в CI эти значения приходят настоящими переменными окружения, файла
    // там нет вовсе; бросок превратил бы штатный режим в отказ.
    expect(() => loadLlmEnv(join(tmpdir(), 'нет-такого-файла-llmenv'))).not.toThrow()
  })
})
