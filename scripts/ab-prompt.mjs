// A/B a change to the EXTRACTION PROMPT against a corpus of real documents (#336/#337).
//
// Why this exists as a committed script: `prompts/extract.ts` carries measured numbers in its
// header and forbids editing the text without re-measuring. That instruction is only followable
// if the harness ships with the repo — the first version of this measurement lived in a scratch
// directory and its raw output was lost, so none of the published numbers could be re-checked.
//
//   pnpm ab:prompt --dir <каталог с .txt>            # текущий промпт против origin/main
//   pnpm ab:prompt --dir <…> --base <файл.ts>        # против произвольной базы
//   pnpm ab:prompt --dir <…> --runs 3                # N прогонов на сторону (по умолчанию 1)
//   pnpm ab:prompt --dir <…> --out ab.json           # куда сложить сырой результат
//
// The corpus is CLIENT DOCUMENTS — keep it OUT of the repository (a git-ignored directory or a
// path outside the tree). The script only reads `.txt`; produce them with the same runners the
// worker uses (server/utils/extractRunners.ts) so the text matches production. The `--out`
// artefact carries the same client data (sums, file names) — its default is git-ignored and
// guarded by tests/noLocalArtifacts.test.ts; if you point `--out` elsewhere, keep it out of git.
//
// Reads the provider key exactly like verify-chat.mjs: .env → process.env.
//
// WHAT THE OUTPUT MEANS — the columns are the only thing a reader has to judge a prompt change by:
//   итог не сошёлся            печатный итог документа не сходится с суммой по строкам. The single
//                              per-document quality signal we have — but blind for a document that
//                              prints no total at all.
//   флаг правился по итогу     `corrected` — the model got priceIncludesVat wrong and the printed
//                              total fixed it. Money ends up right; each one is a warning to a human.
//   взяли слово модели (риск)  `totalAmbiguous` — arithmetic cannot confirm the flag and we took the
//                              model's word. THIS is the realised-risk column, not `flag=true`.
//   с НДС прочитан как без НДС counter-metric: a genuinely VAT-inclusive document read as net. No
//                              other column sees it, so without this a prompt that always answers
//                              «без НДС» would score best on everything.
//   flag=true                  how often the model claimed VAT-inclusive prices. Direction, not harm.
// The paired block at the end is what actually decides: a NET difference proves nothing, only the
// count of documents that DISAGREE between the two sides does (McNemar over the discordant pairs).
import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveLlmConfig } from '../server/agent/llmConfig.ts'
import { makeChatFn } from '../server/agent/openaiChat.ts'
import { runChatExtract } from '../server/agent/chatExtract.ts'
import { buildExtractionPrompt } from '../prompts/extract.ts'
import { reconcilePricing } from '../app/utils/pricing.ts'

const ENV_KEYS = [
  'LLM_PROVIDER',
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL',
  'BITRIXGPT_API_KEY', 'VIBE_API_KEY', 'BITRIXGPT_BASE_URL', 'BITRIXGPT_MODEL',
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_LABEL'
]
try {
  const envText = readFileSync('.env', 'utf8')
  for (const key of ENV_KEYS) {
    const m = envText.match(new RegExp(`^\\s*${key}=(.+)$`, 'm'))
    if (m) process.env[key] = m[1].trim().replace(/^["']|["']$/g, '')
  }
} catch { /* no .env — rely on the ambient environment */ }

const arg = (name, dflt = '') => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const DIR = arg('dir')
if (!DIR) throw new Error('нужен --dir <каталог с .txt документами>')
const RUNS = Math.max(1, Number(arg('runs', '1')))
const OUT = arg('out', 'ab-prompt.json')
const BASE = arg('base')

/**
 * Baseline prompt: an explicit --base module, else origin/main's committed prompt.
 *
 * The temp file goes into a freshly `mkdtemp`'d directory, NOT a name derived from the content
 * hash. A hash-derived name is fully predictable from a public repository, so on a shared machine
 * anyone could pre-place a symlink at that path and have this `writeFile` clobber a file the
 * operator can write (fs.writeFile follows symlinks). `mkdtemp` creates with O_EXCL and a random
 * suffix, which closes that.
 */
async function baselinePrompt() {
  if (BASE) return (await import(pathToFileURL(BASE).href)).buildExtractionPrompt()
  const { execFileSync } = await import('node:child_process')
  const src = execFileSync('git', ['show', 'origin/main:prompts/extract.ts'], { encoding: 'utf8' })
  const dir = await mkdtemp(join(tmpdir(), 'ab-base-'))
  const tmp = join(dir, 'extract.ts')
  await writeFile(tmp, src, 'utf8')
  return (await import(pathToFileURL(tmp).href)).buildExtractionPrompt()
}

/** Dedupe by CONTENT: a corpus often holds the same document under two names, and a flip on a
 *  duplicate moves every count by 2 — inflating both the effect and the apparent noise. */
async function uniqueDocs() {
  const seen = new Map()
  for (const f of (await readdir(DIR)).filter(f => f.endsWith('.txt')).sort()) {
    const h = createHash('md5').update(await readFile(join(DIR, f))).digest('hex')
    if (seen.has(h)) console.log(`  дубль пропущен: ${f} ≡ ${seen.get(h)}`)
    else seen.set(h, f)
  }
  return [...seen.values()]
}

const cfg = resolveLlmConfig(process.env)
if (!cfg.apiKey) throw new Error(`нет ключа для провайдера '${cfg.label}'`)
const chat = makeChatFn(cfg)
const docs = await uniqueDocs()
const SIDES = [['old', await baselinePrompt()], ['new', buildExtractionPrompt()]]
console.log(`provider=${cfg.label} model=${cfg.model} · документов ${docs.length} · прогонов на сторону ${RUNS}\n`)

/** One run's observable outcome. `mismatch` is the only per-document quality signal we have; the
 *  flag counters describe how often the safety net in reconcilePricing had to act. */
const rows = []
for (const f of docs) {
  const text = await readFile(join(DIR, f), 'utf8')
  for (const [side, instructions] of SIDES) {
    for (let run = 0; run < RUNS; run++) {
      const out = await runChatExtract({ documentText: text, instructions, model: cfg.model }, { chat, sleep: ms => new Promise(r => setTimeout(r, ms)), random: () => Math.random() })
      if (!out.ok || !out.document) {
        rows.push({ f, side, run, err: out.error })
        continue
      }
      const d = out.document
      const p = reconcilePricing(d.items, d.priceIncludesVat, d.total)
      rows.push({
        f, side, run,
        mismatch: p.totalMismatch, ambiguous: p.totalAmbiguous, corrected: p.corrected,
        flag: d.priceIncludesVat, header: p.grossTotal, printed: d.total, items: d.items.length,
        // Counter-metric: the failure a `false`-biased prompt would produce — a genuinely
        // VAT-inclusive document read as net inflates the total by the VAT rate, and NONE of the
        // other counters sees it (reconcilePricing keeps «net» silently). Without this, a prompt
        // that always answers `false` scores best on every other number here.
        // Requires a PRINTED total: with none there is nothing to be inconsistent with, and the
        // naive `> (d.total ?? 0)` fired on every document that prints no total at all.
        inclusiveMissed: d.priceIncludesVat !== true && d.total != null
          && p.grossTotal > d.total && !p.totalMismatch && !p.corrected
      })
    }
  }
  const line = side => rows.filter(r => r.f === f && r.side === side)
  const cl = side => line(side).filter(r => !r.err && !r.mismatch).length
  console.log(`${f.slice(0, 38).padEnd(38)} old ${cl('old')}/${RUNS}  new ${cl('new')}/${RUNS}`)
}

await writeFile(OUT, JSON.stringify({ model: cfg.model, runs: RUNS, docs, rows }, null, 2), 'utf8')

const agg = (side) => {
  const r = rows.filter(x => x.side === side && !x.err)
  return {
    'прогонов': r.length,
    'итог не сошёлся': r.filter(x => x.mismatch).length,
    'флаг правился по итогу': r.filter(x => x.corrected).length,
    'взяли слово модели (риск)': r.filter(x => x.ambiguous).length,
    'с НДС прочитан как без НДС': r.filter(x => x.inclusiveMissed).length,
    'flag=true': r.filter(x => x.flag === true).length
  }
}
console.log('\n=== АГРЕГАТ ===')
console.table({ old: agg('old'), new: agg('new') })

// Paired comparison. A net difference alone says nothing: what matters is how many documents
// DISAGREE between the sides (b, c). McNemar's exact two-sided p over those discordant pairs —
// with |b−c| = 1 it is 1.000 for ANY b, i.e. a one-document difference can never be evidence.
const lgamma = (n) => {
  let s = 0
  for (let i = 2; i < n; i++) s += Math.log(i)
  return s
}
const chooseLn = (n, k) => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1)
function mcnemar(b, c) {
  const n = b + c
  if (!n) return 1
  const k = Math.min(b, c)
  let s = 0
  for (let i = 0; i <= k; i++) s += Math.exp(chooseLn(n, i) - n * Math.LN2)
  return Math.min(1, 2 * s)
}
console.log('\n=== ПАРНОЕ СРАВНЕНИЕ (по документам, метрика «итог сошёлся») ===')
let b = 0
let c = 0
let same = 0
for (const f of docs) {
  const ok = side => rows.filter(r => r.f === f && r.side === side && !r.err && !r.mismatch).length
  const o = ok('old')
  const n = ok('new')
  if (n > o) b++
  else if (o > n) c++
  else same++
}
console.log(`стало лучше: ${b} · стало хуже: ${c} · без изменений: ${same}`)
console.log(`McNemar (точный, двусторонний) p = ${mcnemar(b, c).toFixed(3)}` + (b + c < 2 ? '  ← дискордантных пар слишком мало, это не доказательство' : ''))
console.log(`\nсырой результат: ${OUT}`)
