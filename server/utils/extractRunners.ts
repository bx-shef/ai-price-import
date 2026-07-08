import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtractRunners } from './textExtract'

// Live file→text runners (subprocess). Binaries expected in the backend image:
// pdftotext (poppler-utils), libreoffice (office→txt), tesseract-ocr with
// rus+bel+kaz+eng language packs (docs/redesign 06 §6). Glue — validated by
// typecheck; behaviour needs the binaries at runtime.

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

/** Decode a text file: utf-8, falling back to windows-1251 if it looks mojibake. */
async function decodeText(path: string): Promise<string> {
  const buf = await readFile(path)
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  return utf8.includes('�') ? new TextDecoder('windows-1251').decode(buf) : utf8
}

/** Office/spreadsheet → text via libreoffice convert-to-txt (into a temp dir). */
async function officeToText(path: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'procure-office-'))
  try {
    await run('libreoffice', ['--headless', '--convert-to', 'txt:Text', '--outdir', dir, path])
    // libreoffice names the output after the input base name with a .txt extension.
    const base = (path.split('/').pop() ?? 'out').replace(/\.[^.]+$/, '')
    return await decodeText(join(dir, `${base}.txt`))
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
