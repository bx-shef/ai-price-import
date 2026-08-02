// Generate the Open Graph share image (public/og.png, 1200×630) from an inline HTML
// template using the pre-installed Chromium (same resolver as screenshot.mjs).
// Run when the landing copy or the card template changes:  pnpm og
//
// The PNG is a committed static asset (served by nginx, referenced by og:image on the landing).
// Regenerate + commit when the card changes — and you cannot silently forget: the run also writes
// `public/og.stamp.json` (a hash of the rendered markup) and `tests/ogStamp.test.ts` recomputes it,
// so shipping stale pixels fails CI (#329). Dev-only, not part of SSG.
//
// The markup itself lives in ./lib/ogTemplate.mjs so the guard can rebuild the exact same string.
// Copy comes FROM the landing content module (#298) — inline copy drifted the moment someone edited
// landing.ts. The `og` script passes --experimental-strip-types explicitly (same as client-bank's
// recon scripts): default stripping only arrived in Node 22.18, while our `engines` allows any >=22.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { resolveChromium } from './lib/chromium.mjs'
import { buildOgHtml, HEIGHT, WIDTH } from './lib/ogTemplate.mjs'
import { ogStamp } from './lib/ogStamp.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'public', 'og.png')
const STAMP = join(ROOT, 'public', 'og.stamp.json')

const html = await buildOgHtml()

const browser = await chromium.launch({ executablePath: await resolveChromium() })
try {
  await mkdir(join(ROOT, 'public'), { recursive: true })
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.screenshot({ path: OUT, type: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } })
  // Stamp AFTER the screenshot: if rendering throws, the old stamp stays describing the old PNG.
  // The pair on disk is then never «fresh stamp, stale pixels» — the one combination the guard
  // cannot detect, because it compares the stamp with the sources, not with the image.
  await writeFile(STAMP, `${JSON.stringify(ogStamp(html, await readFile(OUT)), null, 2)}\n`)
  console.log(`✓ ${OUT.replace(ROOT, '.')} (${WIDTH}×${HEIGHT}) + og.stamp.json`)
} finally {
  await browser.close()
}
