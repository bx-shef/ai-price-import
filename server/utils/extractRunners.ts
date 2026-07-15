import { spawn } from 'node:child_process'
import { mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtractRunners } from './textExtract'

// Live file→text runners (subprocess). Binaries expected in the backend image:
// pdftotext (poppler-utils), libreoffice (office→txt), tesseract-ocr with
// rus+bel+kaz+eng language packs (docs/redesign 06 §6). Glue — validated by
// typecheck; behaviour needs the binaries at runtime.
//
// DEPLOY NOTE: the timeout bounds CPU-time but NOT peak memory. A crafted upload
// (zip/XML bomb, huge-dimension image) can OOM the worker. The backend container
// MUST run with a memory limit (compose `mem_limit` / k8s limits) — that is the
// enforcement layer, not this code.

const RUN_TIMEOUT_MS = 90_000

// Least-privilege env for the extraction subprocesses (libreoffice/pdftotext/tesseract/
// pdftoppm). They run UNTRUSTED documents (office macros, crafted PDFs), so they must NOT
// see backend secrets — DATABASE_URL, B24_TOKEN_ENC_KEY, B24_CLIENT_SECRET, app token, etc.
// (mirrors the agent's agentSpawnEnv guard). Only what these tools legitimately need to
// run + render text correctly is passed through. GH #99.
const SUBPROCESS_ENV_ALLOW = [
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', // process basics + temp dir
  'LANG', 'LC_ALL', 'LANGUAGE', 'TZ', // locale (UTF-8 filenames, number formatting)
  'OMP_THREAD_LIMIT', 'OMP_NUM_THREADS', // bound tesseract/OpenMP threads on minimal infra (#95)
  'FONTCONFIG_PATH', 'FONTCONFIG_FILE', 'TESSDATA_PREFIX' // libreoffice fonts + tesseract data
] as const

/** Build the secret-free subprocess env (allow-list from `full`, then `extra` overrides). Pure. */
export function subprocessEnv(
  full: Record<string, string | undefined>,
  extra?: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of SUBPROCESS_ENV_ALLOW) {
    const v = full[k]
    if (v != null && v !== '') out[k] = String(v)
  }
  return { ...out, ...extra }
}

function run(bin: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: subprocessEnv(process.env, env)
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${bin}: timed out`))
    }, RUN_TIMEOUT_MS)
    child.stdout.on('data', (d) => {
      out += String(d)
    })
    child.stderr.on('data', (d) => {
      err += String(d)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e instanceof Error ? e : new Error(String(e)))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(err.trim() || `${bin}: exited ${code}`))
    })
  })
}

/**
 * Decode bytes as UTF-8, falling back to windows-1251 only when the bytes are NOT
 * valid UTF-8. Uses a fatal decoder (throws on invalid sequences) rather than
 * scanning for U+FFFD — a valid UTF-8 document may legitimately contain U+FFFD and
 * must not be flipped to 1251. Pure (Uint8Array in) → unit-tested.
 */
export function decodeBytes(buf: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('windows-1251').decode(buf)
  }
}

async function decodeText(path: string): Promise<string> {
  return decodeBytes(await readFile(path))
}

/** Spreadsheet office formats — export as CSV (tabular), not the Writer text filter. */
const SPREADSHEET_EXT = new Set(['xls', 'xlsx', 'xlsm', 'ods', 'fods'])

// CSV export with PINNED FilterOptions so the output is deterministic regardless of the
// container's locale (a locale-default decimal comma would corrupt prices). Tokens:
// 9 = TAB field separator (never collides with a decimal comma, and the downstream demo
// parser detects TAB tables), 34 = '"' text delimiter, 76 = UTF-8. See the StarCalc CSV
// filter docs. Uses TAB, not comma, on purpose.
// Trailing `,,,,,,,,,-1` = the "sheet to export" token set to -1 → export EVERY sheet
// (one CSV per sheet), not just the active/first one. Without it a multi-sheet workbook
// loses non-first sheets — e.g. a ТТН whose goods live on an «Приложение» sheet extracted
// to 0 items (GH #76). The 3 leading tokens (9,34,76) keep their exact prior meaning; the
// empty middle tokens hold libreoffice defaults, so quoting/format is unchanged.
const CSV_FILTER = 'csv:Text - txt - csv (StarCalc):9,34,76,,,,,,,,,-1'

/**
 * Pick the libreoffice `--convert-to` target for an office file. Spreadsheets export to
 * CSV (tab-separated, UTF-8) so the cell grid survives; text documents (doc/docx/odt/rtf)
 * use the plain-text filter. Pure → unit-tested (the subprocess/IO in officeToText is
 * not). `outExt` is the extension libreoffice gives the produced file.
 */
export function officeConvertTarget(path: string): { filter: string, outExt: string } {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  return SPREADSHEET_EXT.has(ext)
    ? { filter: CSV_FILTER, outExt: 'csv' }
    : { filter: 'txt:Text', outExt: 'txt' }
}

/**
 * Fail-fast cap on how many per-sheet CSVs we read into memory. A crafted workbook can
 * carry thousands of (tiny) sheets → the all-sheets export makes one CSV each; without a
 * bound we would `readFile` them all at once BEFORE the downstream MAX_DOCUMENT_TEXT cap.
 * A loud throw (not silent truncation) is the contract, like MAX_DOCUMENT_TEXT.
 */
export const MAX_SHEET_CSVS = 64

/**
 * Parse libreoffice CSV `--convert-to` stdout into the produced `.csv` paths IN WORKBOOK
 * SHEET ORDER. libreoffice prints one line per sheet in sheet-index order — either
 * `Writing sheet <name> -> <path>.csv` (multi-sheet) or `convert <in> -> <path>.csv using
 * filter :…` (single). Preserving this order keeps the document HEADER sheet (supplier /
 * contractor) first, which a filename `.sort()` would break (alphabetical, and "Лист10"
 * before "Лист2"). Pure → unit-tested.
 */
export function parseOfficeCsvOutputs(stdout: string): string[] {
  const paths: string[] = []
  for (const line of stdout.split('\n')) {
    const arrow = line.indexOf('-> ')
    if (arrow < 0) continue
    let rest = line.slice(arrow + 3)
    const uf = rest.indexOf(' using filter')
    if (uf >= 0) rest = rest.slice(0, uf)
    rest = rest.trim()
    if (rest.toLowerCase().endsWith('.csv')) paths.push(rest)
  }
  return paths
}

/**
 * Office document → text via libreoffice (into a temp dir). The filter is chosen from
 * `fileName` (its real extension) — `path` is the file libreoffice reads and may be an
 * extension-less temp (`<jobId>.bin`) whose format libreoffice sniffs from content.
 * Spreadsheets export EVERY sheet (CSV_FILTER `-1`) → we join all sheets, in workbook
 * order, so goods on a non-first sheet (e.g. a ТТН «Приложение») aren't lost (GH #76).
 */
async function officeToText(path: string, fileName: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'procure-office-'))
  try {
    const { filter, outExt } = officeConvertTarget(fileName)
    // LANG=C.UTF-8 so libreoffice writes multi-byte (Cyrillic) per-sheet filenames as valid
    // UTF-8 — otherwise a non-UTF-8 container locale FAILS to write «Приложение».csv at all
    // (verified: dir stays empty). Harmless for the txt path.
    const stdout = await run('libreoffice', ['--headless', '--convert-to', filter, '--outdir', dir, path],
      { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' })
    if (outExt === 'csv') {
      // Primary: read the produced CSVs in workbook sheet order (from stdout). Fallback to a
      // readdir (order not guaranteed → sorted) only if stdout parsing yields nothing.
      let csvPaths = parseOfficeCsvOutputs(stdout)
      if (!csvPaths.length) {
        csvPaths = (await readdir(dir)).filter(f => f.toLowerCase().endsWith('.csv')).sort()
          .map(f => join(dir, f))
      }
      if (csvPaths.length) {
        if (csvPaths.length > MAX_SHEET_CSVS) {
          throw new Error(`слишком много листов в книге (${csvPaths.length} > ${MAX_SHEET_CSVS})`)
        }
        const parts = await Promise.all(csvPaths.map(p => decodeText(p)))
        return parts.map(p => p.trim()).filter(Boolean).join('\n') // drop empty sheets
      }
      // No CSV at all (token ignored + empty dir): fall through to the base-named file.
    }
    const base = (path.split('/').pop() ?? 'out').replace(/\.[^.]+$/, '')
    return await decodeText(join(dir, `${base}.${outExt}`))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Fail-fast cap on scanned-PDF pages rasterized + OCR'd (memory/CPU bound on minimal infra). */
export const MAX_OCR_PDF_PAGES = 30

const OCR_LANGS = 'rus+bel+kaz+eng'

/**
 * Order pdftoppm page PNGs by their NUMERIC page index (`p-2.png` before `p-10.png`) — a
 * plain `.sort()` is lexicographic and would interleave pages wrong. Non-PNG / unnumbered
 * names are dropped. Pure → unit-tested.
 */
export function orderPdfPageImages(names: string[]): string[] {
  return names
    .filter(n => n.toLowerCase().endsWith('.png'))
    .map(n => ({ n, i: Number((n.match(/-(\d+)\.png$/i) ?? [])[1] ?? NaN) }))
    .filter(x => Number.isFinite(x.i))
    .sort((a, b) => a.i - b.i)
    .map(x => x.n)
}

/** True when a header buffer carries the PDF magic `%PDF-`. The spec allows up to ~1024
 *  bytes of junk BEFORE the header, so we search the window, not just offset 0. Pure. */
export function hasPdfMagic(head: Uint8Array): boolean {
  return Buffer.from(head).toString('latin1').includes('%PDF-')
}

/** Sniff whether `path` is a PDF by scanning its first 1 KiB for the `%PDF-` magic. */
async function isPdfFile(path: string): Promise<boolean> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(1024)
    const { bytesRead } = await fh.read(buf, 0, 1024, 0)
    return hasPdfMagic(buf.subarray(0, bytesRead))
  } finally {
    await fh.close()
  }
}

/**
 * OCR a SCANNED PDF: rasterize each page to PNG (pdftoppm) then run tesseract per page,
 * SEQUENTIALLY (one page at a time keeps CPU/RAM bounded on the minimal profile). tesseract
 * cannot read a PDF directly — the scanned-PDF fallback used to hand it the `.pdf` and got
 * «Pdf reading is not supported», so scanned invoices extracted nothing (GH #100). Pages are
 * joined in numeric page order.
 *
 * DoS bounds are enforced INSIDE pdftoppm (before anything hits disk): `-l` caps how many
 * pages get rendered (a crafted 1000-page scan can't fill the disk), `-scale-to` caps each
 * PNG's long edge in pixels (a giant MediaBox × high DPI can't OOM tesseract). Worst case is
 * bounded to MAX_OCR_PDF_PAGES pages processed one-by-one — a single document can still hold
 * a worker slot for a while (per-page tesseract is seconds; the RUN_TIMEOUT_MS cap is
 * per-process, not per-doc), acceptable on the "stable, not fast" profile (09-deploy).
 */
async function ocrPdf(path: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'procure-ocrpdf-'))
  try {
    // `-l MAX+1` renders at most MAX_OCR_PDF_PAGES+1 pages → the check below can still detect
    // "too many" without pdftoppm rasterizing the whole crafted document first. `-scale-to`
    // (long edge px) bounds output size regardless of page DPI/dimensions.
    await run('pdftoppm', ['-png', '-scale-to', '3000', '-f', '1', '-l', String(MAX_OCR_PDF_PAGES + 1),
      path, join(dir, 'p')])
    const pages = orderPdfPageImages(await readdir(dir))
    if (!pages.length) throw new Error('pdftoppm: страницы не получены')
    if (pages.length > MAX_OCR_PDF_PAGES) {
      throw new Error(`слишком много страниц для OCR (> ${MAX_OCR_PDF_PAGES})`)
    }
    const texts: string[] = []
    for (const p of pages) {
      texts.push(await run('tesseract', [join(dir, p), 'stdout', '-l', OCR_LANGS]))
    }
    return texts.map(t => t.trim()).filter(Boolean).join('\n')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export const liveExtractRunners: ExtractRunners = {
  readText: decodeText,
  pdfToText: path => run('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-']),
  officeToText,
  // OCR handles both images and SCANNED PDFs: a PDF (magic `%PDF-`) is rasterized first,
  // because tesseract can't read PDF. The routing (textExtract) calls this for image files
  // AND as the scanned-PDF fallback, so the sniff — not the caller — picks the path.
  ocr: async path => (await isPdfFile(path)) ? ocrPdf(path) : run('tesseract', [path, 'stdout', '-l', OCR_LANGS])
}
