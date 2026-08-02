import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderMarkdown } from '../app/utils/markdownLite'

const readDoc = (name: string) => readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8')

// #297 вариант В: юридические документы живут одним файлом в `docs/`, а страница их РЕНДЕРИТ —
// второй копии нет по построению. Значит корректность рендера это и есть корректность публикуемого
// документа: пропавший пункт или съеденная таблица — это уже юридический дефект, а не косметика.

describe('безопасность рендера', () => {
  it('разметка из исходника не исполняется, а показывается текстом', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('ссылка с опасной схемой остаётся текстом', () => {
    // Документ наш, но юридическая страница — ровно то место, где нельзя доверять этому вечно.
    const html = renderMarkdown('[клик](javascript:alert(1))')
    expect(html).not.toContain('href="javascript')
    expect(html).toContain('[клик]')
  })

  it('ссылка на чужой хост в виде «относительной» не проходит', () => {
    // `//evil.test` и `/\evil.test` начинаются со слэша, но браузер уводит по ним на ДРУГОЙ хост.
    // Фишинговая ссылка с нашей же юридической страницы — худшее место для такой ошибки.
    for (const bad of ['//evil.test/login', '/\\evil.test/login', '//evil.test']) {
      const html = renderMarkdown(`[кабинет](${bad})`)
      expect(html, bad).not.toContain('<a ')
    }
  })

  it('внутренние и внешние ссылки работают', () => {
    expect(renderMarkdown('[политика](/privacy)')).toContain('<a href="/privacy">политика</a>')
    expect(renderMarkdown('[сайт](https://example.com)')).toContain('<a href="https://example.com">сайт</a>')
  })

  it('экранируются все пять опасных символов', () => {
    // Проверяем через публичный вход: сама функция экранирования намеренно не экспортируется —
    // имя `escapeHtml` уже занято в `app/utils/feedback.ts`, а Nuxt авто-импортирует оба в один
    // неймспейс, и второй молча побеждает.
    expect(renderMarkdown(`<&>"'`)).toBe(`<p>&lt;&amp;&gt;&quot;&#39;</p>`)
  })
})

describe('конструкции документов', () => {
  it('заголовок первого уровня не рендерится — он у страницы свой', () => {
    // Иначе на странице было бы два H1: собственный и из файла.
    const html = renderMarkdown('# Заголовок\n\n## Раздел')
    expect(html).not.toContain('Заголовок')
    expect(html).toContain('<h2>Раздел</h2>')
  })

  it('абзац, список, нумерованный список', () => {
    const html = renderMarkdown('Текст\n\n- один\n- два\n\n1. первый\n2. второй')
    expect(html).toContain('<p>Текст</p>')
    expect(html).toContain('<ul><li>один</li><li>два</li></ul>')
    expect(html).toContain('<ol><li>первый</li><li>второй</li></ol>')
  })

  it('таблица целиком, включая последнюю строку', () => {
    // Съеденная последняя строка — самая незаметная потеря: в политике таблицей описано, ЧТО
    // именно мы храним, и пропавшая строка меняет смысл документа.
    const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nПосле таблицы')
    expect(html).toContain('<th>A</th><th>B</th>')
    expect(html).toContain('<td>3</td><td>4</td>')
    expect(html).toContain('<p>После таблицы</p>') // текст после таблицы не проглочен
  })

  it('жирный, код, цитата и разделитель', () => {
    expect(renderMarkdown('**важно**')).toContain('<strong>важно</strong>')
    expect(renderMarkdown('`код`')).toContain('<code>код</code>')
    expect(renderMarkdown('> примечание')).toContain('<blockquote>примечание</blockquote>')
    expect(renderMarkdown('---')).toContain('<hr>')
  })

  it('звёздочки внутри кода не превращаются в разметку', () => {
    expect(renderMarkdown('`**не жирный**`')).toContain('<code>**не жирный**</code>')
  })

  it('пустой документ не роняет рендер', () => {
    expect(renderMarkdown('')).toBe('')
  })
})

describe('реальные документы рендерятся без потерь', () => {
  const eula = readDoc('eula.md')
  const privacy = readDoc('privacy-policy.md')

  it('лицензия: все разделы на месте, включая применимое право', () => {
    const html = renderMarkdown(eula)
    for (const n of ['Основные термины', 'Предмет Соглашения', 'Авторские права', 'Условия использования',
      'Ответственность сторон', 'Ограниченная гарантия', 'Действие, изменение', 'Применимое право',
      'непреодолимой силы', 'Контактная информация']) {
      expect(html, n).toContain(n)
    }
  })

  it('политика: таблицы не потерялись', () => {
    const html = renderMarkdown(privacy)
    expect((html.match(/<table>/g) ?? []).length).toBeGreaterThan(0)
  })

  it('в готовой разметке не остаётся сырых markdown-маркеров', () => {
    // Признак того, что конструкция встретилась, но не поддержана — читатель увидит «##» глазами.
    for (const [name, md] of [['eula', eula], ['privacy', privacy]] as const) {
      const html = renderMarkdown(md)
      expect(html, `${name}: незакрытые заголовки`).not.toMatch(/<p>#{1,6}\s/)
      expect(html, `${name}: незакрытые таблицы`).not.toMatch(/<p>\|/)
    }
  })
})

describe('страницы действительно публикуются (#297)', () => {
  // Разрыв, который иначе никто не заметит: sitemap объявляет адрес, гард разрешает индексацию —
  // а страница не собирается статикой и отдаёт 404 ровно там, куда позвали краулера и модератора.
  it('оба адреса стоят в пререндере', () => {
    const config = readFileSync(new URL('../nuxt.config.ts', import.meta.url), 'utf8')
    const routes = /routes:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? ''
    expect(routes).toContain(`'/eula'`)
    expect(routes).toContain(`'/privacy'`)
  })

  it('страница объявляет свой собственный адрес, а не соседний', () => {
    // Опечатка `path="/eula"` на странице политики дала бы канонический адрес чужого документа —
    // и поисковик склеил бы два разных юридических текста в один.
    const eula = readFileSync(new URL('../app/pages/eula.vue', import.meta.url), 'utf8')
    const privacy = readFileSync(new URL('../app/pages/privacy.vue', import.meta.url), 'utf8')
    expect(eula).toContain('path="/eula"')
    expect(eula).toContain('docs/eula.md?raw')
    expect(privacy).toContain('path="/privacy"')
    expect(privacy).toContain('docs/privacy-policy.md?raw')
  })
})
