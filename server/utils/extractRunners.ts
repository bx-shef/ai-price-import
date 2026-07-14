import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
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
const CSV_FILTER = 'csv:Text - txt - csv (StarCalc):9,34,76'

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
 * Office document → text via libreoffice (into a temp dir). The filter is chosen from
 * `fileName` (its real extension) — `path` is the file libreoffice reads and may be an
 * extension-less temp (`<jobId>.bin`) whose format libreoffice sniffs from content. The
 * output is named after the INPUT path's base, so read `<pathBase>.<outExt>`.
 */
async function officeToText(path: string, fileName: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'procure-office-'))
  try {
    const { filter, outExt } = officeConvertTarget(fileName)
    await run('libreoffice', ['--headless', '--convert-to', filter, '--outdir', dir, path])
    const base = (path.split('/').pop() ?? 'out').replace(/\.[^.]+$/, '')
    return await decodeText(join(dir, `${base}.${outExt}`))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export const liveExtractRunners: ExtractRunners = {
  readText: decodeText,
  pdfToText: path => run('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-']),
  officeToText,
  ocr: path => run('tesseract', [path, 'stdout', '-l', 'rus+bel+kaz+eng'])
}
