import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LANDING_DESCRIPTION, LANDING_FORMATS, LANDING_TITLE } from '../../app/utils/landing.ts'
import { brandBadgeHtml } from '../../app/config/brandBadge.ts'

// The share card's markup, extracted from the generator so BOTH the generator and the freshness
// guard (tests/ogStamp.test.ts) build the exact same string (#329). Hashing the finished HTML — not
// just the copy — means the guard also covers layout, colours, badge chrome and the inlined logo:
// anything that changes what the PNG looks like demands a rebuild.
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

export const WIDTH = 1200
export const HEIGHT = 630
// The badge is authored at landing size (14px brand text); on a 1200×630 canvas whose title is 76px
// that would be invisible, so every geometric token is scaled by the same factor.
export const BADGE_SCALE = 2.2

/** Build the card HTML. Async because the logo is inlined as a data URI (no network in Chromium). */
export async function buildOgHtml() {
  // ⚠ Расщепления по « в Bitrix24» больше нет (#412): платформа ушла из ИМЕНИ продукта в
  // подзаголовок, поэтому акцентировать в заголовке нечего. Ветка оставалась бы мёртвым кодом,
  // который читается как «имя всё ещё может кончаться на Bitrix24».
  const [titleHead, titleTail] = [LANDING_TITLE, '']
  const logoSvg = await readFile(join(ROOT, 'public', 'favicon.svg'), 'utf8')
  const logoData = `data:image/svg+xml;base64,${Buffer.from(logoSvg).toString('base64')}`

  return `<!doctype html><html><head><meta charset="utf-8"><style>
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
  /* The SHORT description, not the hero subtitle: in a feed the card is rendered ~500px wide, where
     the 195-character subtitle became four lines of ~13px — the first thing a reader skips. */
  .sub { font-size: 37px; color: #cbd5e1; margin-top: 32px; max-width: 1000px; line-height: 1.3; }
  /* Fixed gap, not margin-top:auto — auto collapses to zero once the text fills the card, which
     glued the formats line to the last line of copy. */
  .foot { font-size: 27px; color: #94a3b8; margin-top: 40px; }
  .head { display: flex; align-items: center; gap: 26px; }
  .logo { width: 88px; height: 88px; border-radius: 20px; }
</style></head><body>
  <div class="card">
    <div class="head">
      <img class="logo" src="${logoData}" alt="">
      ${brandBadgeHtml('Bitrix24', 'Приложение', BADGE_SCALE)}
    </div>
    <div class="title">${titleHead}${titleTail}</div>
    <div class="sub">${LANDING_DESCRIPTION}</div>
    <div class="foot">${LANDING_FORMATS.join(' · ')}</div>
  </div>
</body></html>`
}
