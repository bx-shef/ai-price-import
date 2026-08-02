/**
 * The smallest Markdown renderer that our legal documents actually need (#297, вариант В).
 *
 * WHY AT ALL. The licence and the privacy policy must exist in two places at once: as a file a
 * lawyer can read and edit (`docs/*.md`) and as a public page at a permanent HTTPS address, which
 * the Bitrix24 Market requires. Keeping two copies is how the publisher's requisites drifted in the
 * first place (#297 п.1), so the page RENDERS the file instead of restating it — one source, and a
 * stale page is impossible by construction.
 *
 * WHY NOT A LIBRARY. The input is our own small, known set of constructs; a general parser would add
 * a dependency, a bundle and a configuration surface for no gain here. If the documents ever grow
 * footnotes, images or nested lists, replace this — do not extend it into a half-parser.
 *
 * SAFETY. Everything is escaped FIRST, and markup is produced only from constructs recognised
 * afterwards. Raw HTML in the source is therefore rendered as visible text, not executed — the
 * documents are ours, but a legal page is exactly the wrong place to trust that forever.
 *
 * Supported: `##`/`###` headings, paragraphs, `---`, `-`/`1.` lists, `>` blockquote, tables,
 * `**bold**`, `` `code` ``, `[text](href)`. Deliberately NOT supported: raw HTML, images, nested
 * lists, footnotes.
 */

/** The five characters that turn text into markup. Escaped before anything else runs.
 *  NOT exported: `app/utils/feedback.ts` already exports a function of this name, and Nuxt
 *  auto-imports both into one namespace — the second one silently wins. */
function escapeMarkup(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Links are the one construct that carries a URL, so the scheme is checked: only same-document
 * anchors, site-relative paths and http(s) survive. `javascript:` and `data:` render as plain text —
 * a legal page must not be able to become an attack surface through a copy-paste into the source.
 */
function safeHref(href: string): string | null {
  const h = href.trim()
  if (!h) return null
  if (h.startsWith('/') || h.startsWith('#')) return h
  return /^https?:\/\//i.test(h) ? h : null
}

/**
 * Inline markup inside an already-escaped line.
 *
 * Code spans are lifted out FIRST and put back LAST: `**` and `[…]()` inside `` `code` `` are part
 * of the quoted text, not markup, and running the other rules over them turned a literal `**` in a
 * code sample into bold.
 */
function inline(escaped: string): string {
  // Плейсхолдер — символ из приватной зоны Unicode: он не может встретиться в юридическом тексте
  // и, в отличие от \u0000, не считается управляющим (правило no-control-regex).
  const codes: string[] = []
  const withPlaceholders = escaped.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code)
    return `\uE000${codes.length - 1}\uE000`
  })
  const marked = withPlaceholders
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text: string, href: string) => {
      const safe = safeHref(href)
      return safe ? `<a href="${safe}">${text}</a>` : whole
    })
  return marked.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`)
}

/** One table row → cells, without the outer pipes. */
function cells(row: string): string[] {
  return row.replace(/^\||\|$/g, '').split('|').map(c => c.trim())
}

const isTableDivider = (line: string) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim())

/**
 * Render a Markdown document to HTML.
 *
 * The H1 is dropped on purpose: the page renders its own heading (and it must be exactly one), so
 * keeping the file's would produce two.
 */
export function renderMarkdown(md: string): string {
  const lines = escapeMarkup(md.replace(/\r\n/g, '\n')).split('\n')
  const out: string[] = []
  let para: string[] = []
  let list: string[] = []
  let listTag: 'ul' | 'ol' = 'ul'
  let quote: string[] = []

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  const flushList = () => {
    if (list.length) out.push(`<${listTag}>${list.map(i => `<li>${inline(i)}</li>`).join('')}</${listTag}>`)
    list = []
  }
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`)
    quote = []
  }
  const flushAll = () => {
    flushPara()
    flushList()
    flushQuote()
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const line = raw.trim()

    if (!line) {
      flushAll()
      continue
    }
    if (/^#{1,6}\s/.test(line)) {
      flushAll()
      const level = (line.match(/^#+/)?.[0].length ?? 1)
      if (level === 1) continue // the page owns the H1
      const tag = level === 2 ? 'h2' : 'h3'
      out.push(`<${tag}>${inline(line.replace(/^#+\s*/, ''))}</${tag}>`)
      continue
    }
    if (/^(-{3,}|\*{3,})$/.test(line)) {
      flushAll()
      out.push('<hr>')
      continue
    }
    if (line.startsWith('&gt;')) { // escaped '>' — blockquote
      flushPara()
      flushList()
      quote.push(line.replace(/^&gt;\s?/, ''))
      continue
    }
    if (line.startsWith('|') && isTableDivider(lines[i + 1] ?? '')) {
      flushAll()
      const head = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
        rows.push(cells((lines[i] ?? '').trim()))
        i++
      }
      i-- // the loop's own i++ consumes the terminating line
      out.push(
        `<table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      )
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    const numbered = /^\d+\.\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flushPara()
      flushQuote()
      const tag = bullet ? 'ul' : 'ol'
      if (list.length && tag !== listTag) flushList()
      listTag = tag
      list.push((bullet ?? numbered)![1] ?? '')
      continue
    }
    flushList()
    flushQuote()
    para.push(line)
  }
  flushAll()
  return out.join('\n')
}
