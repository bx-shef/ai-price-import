// Generate the Open Graph share image (public/og.png, 1200×630) from an inline HTML
// template using the pre-installed Chromium (same resolver as screenshot.mjs).
// Run when the landing title/branding changes:  pnpm og
//
// The PNG is a committed static asset (served by nginx, referenced by og:image in
// app.vue). Regenerate + commit when you edit the template below. Dev-only, not SSG.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { resolveChromium } from './lib/chromium.mjs'
// Card copy comes FROM the landing content module (#298) — the previous inline copy drifted from
// the real title the moment someone edited landing.ts. The `og` script passes
// --experimental-strip-types explicitly (same as client-bank's recon scripts): default stripping
// only arrived in Node 22.18, while our `engines` allows any >=22 — without the flag the script
// would crash on 22.0–22.17. landing.ts has no imports, so no loader is needed.
import { LANDING_TITLE, LANDING_SUBTITLE, LANDING_FORMATS } from '../app/utils/landing.ts'
// The eyebrow used to be a flat text line while the landing wore a pill badge for the same mark
// (#329). Chromium renders inline HTML here — no Vue, no Tailwind — so the badge chrome comes from
// the shared token module, which is pinned to BrandBadge.vue by tests/brandBadge.test.ts.
import { brandBadgeHtml } from '../app/config/brandBadge.ts'
import { ogStamp } from './lib/ogStamp.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'public', 'og.png')
const STAMP = join(ROOT, 'public', 'og.stamp.json')
const WIDTH = 1200
const HEIGHT = 630
// The badge is authored at landing size (14px brand text); on a 1200×630 canvas whose title is
// 76px that would be invisible, so every geometric token is scaled by the same factor.
const BADGE_SCALE = 2.2

// The title is split so «Bitrix24» keeps the accent colour regardless of wording.
const [titleHead, titleTail] = LANDING_TITLE.split(/ в Bitrix24$/).length === 1
  ? [LANDING_TITLE, '']
  : [LANDING_TITLE.replace(/ в Bitrix24$/, ''), ' в <span>Bitrix24</span>']
const logoSvg = await readFile(join(ROOT, 'public', 'favicon.svg'), 'utf8')
const logoData = `data:image/svg+xml;base64,${Buffer.from(logoSvg).toString('base64')}`

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body { width: ${WIDTH}px; height: ${HEIGHT}px; }
  .card {
    width: ${WIDTH}px; height: ${HEIGHT}px; padding: 84px 88px;
    background:
      radial-gradient(900px 500px at 12% -10%, rgba(34,211,238,0.22), transparent 60%),
      radial-gradient(700px 500px at 108% 120%, rgba(99,102,241,0.20), transparent 60%),
      #05010f;
    color: #fff; display: flex; flex-direction: column; justify-content: center;
    font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  .title { font-size: 76px; font-weight: 800; line-height: 1.05; margin-top: 26px; }
  .title span { color: #22d3ee; }
  .sub { font-size: 31px; color: #cbd5e1; margin-top: 30px; max-width: 990px; line-height: 1.32; }
  /* Fixed gap, not margin-top:auto — the subtitle is long enough to fill the card, and auto
     collapses to zero there, gluing the formats line to the last line of text. */
  .foot { font-size: 27px; color: #94a3b8; margin-top: 38px; }
  .head { display: flex; align-items: center; gap: 26px; }
  .logo { width: 88px; height: 88px; border-radius: 20px; }
</style></head><body>
  <div class="card">
    <div class="head">
      <img class="logo" src="${logoData}" alt="">
      ${brandBadgeHtml('Bitrix24', 'Приложение', BADGE_SCALE)}
    </div>
    <div class="title">${titleHead}${titleTail}</div>
    <div class="sub">${LANDING_SUBTITLE}</div>
    <div class="foot">${LANDING_FORMATS.join(' · ')}</div>
  </div>
</body></html>`

const browser = await chromium.launch({ executablePath: await resolveChromium() })
try {
  await mkdir(join(ROOT, 'public'), { recursive: true })
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.screenshot({ path: OUT, type: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } })
  // Stamp what the card was rendered FROM (#329). `pnpm og` is a manual step and the PNG is a
  // committed binary, so nothing stopped a copy edit from shipping with a stale card — that is
  // exactly how the old subtitle and «1С» survived PR #325. A test recomputes this hash from the
  // current sources and fails when they disagree. Timestamps can't serve here: git does not
  // preserve mtimes, so on a fresh CI clone every file looks equally new.
  await writeFile(STAMP, `${JSON.stringify(ogStamp({ title: LANDING_TITLE, subtitle: LANDING_SUBTITLE, formats: LANDING_FORMATS, badge: brandBadgeHtml('Bitrix24', 'Приложение', BADGE_SCALE) }), null, 2)}\n`)
  console.log(`✓ ${OUT.replace(ROOT, '.')} (${WIDTH}×${HEIGHT}) + og.stamp.json`)
} finally {
  await browser.close()
}
