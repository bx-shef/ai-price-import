// Generate downloadable PDF demo samples from the plain-text sources in public/demo/*.txt.
// The landing offers these for download so a client can grab a realistic PDF invoice/КП/ТТН
// and drop it into the AI demo (the AI path parses PDFs). Committed as static assets — run
// this only when the source .txt samples change. Dev-only, NOT part of the SSG build.
//
//   node scripts/make-demo-pdfs.mjs
//
// Uses the pre-installed Chromium (same resolver as the screenshot script); pipe-separated
// lines become a table, everything else becomes headings/paragraphs so the output reads like
// a real document while staying faithful to the sample text.

import { readFile, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { resolveChromium } from './lib/chromium.mjs'

const DEMO_DIR = fileURLToPath(new URL('../public/demo', import.meta.url))

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Turn a sample's plain text into styled document HTML (title + meta lines + goods table). */
function toHtml(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const title = lines.shift() ?? 'Документ'
  const rows = []
  const paras = []
  for (const line of lines) {
    if (line.includes('|')) rows.push(line.split('|').map(c => c.trim()))
    else paras.push(line)
  }
  let table = ''
  if (rows.length) {
    const [head, ...body] = rows
    const th = head.map(c => `<th>${esc(c)}</th>`).join('')
    const trs = body.map((r) => {
      const cls = /итого|ндс|всего/i.test(r[0] ?? '') ? ' class="total"' : ''
      return `<tr${cls}>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`
    }).join('')
    table = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`
  }
  const meta = paras.map(p => `<p>${esc(p)}</p>`).join('')
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font: 13px/1.5 'DejaVu Sans', Arial, sans-serif; color: #111; margin: 0; padding: 32px 36px; }
    h1 { font-size: 18px; margin: 0 0 16px; border-bottom: 2px solid #0891b2; padding-bottom: 8px; }
    p { margin: 3px 0; }
    table { width: 100%; border-collapse: collapse; margin: 18px 0; }
    th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; }
    th { background: #f1f5f9; font-weight: 600; }
    td:not(:first-child), th:not(:first-child) { text-align: right; white-space: nowrap; }
    tr.total td { font-weight: 700; background: #f8fafc; }
  </style></head><body><h1>${esc(title)}</h1>${meta}${table}</body></html>`
}

const browser = await chromium.launch({ executablePath: await resolveChromium() })
try {
  const page = await browser.newPage()
  const files = (await readdir(DEMO_DIR)).filter(f => f.endsWith('.txt')).sort()
  for (const f of files) {
    const text = await readFile(join(DEMO_DIR, f), 'utf8')
    await page.setContent(toHtml(text), { waitUntil: 'load' })
    const out = join(DEMO_DIR, `${basename(f, '.txt')}.pdf`)
    await page.pdf({ path: out, format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } })
    console.log('✓', basename(out))
  }
} finally {
  await browser.close()
}
