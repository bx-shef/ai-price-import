// Generate the app-rating hint GIF (public/app-rating-demo.gif) — the little animation inside the
// «оцените приложение» modal showing WHERE to click on the Market card. Run: pnpm rating-demo
//
// Why SYNTHETIC and why that is fine now (#380, owner decision 2026-08-04): the original screen
// capture showed a DIFFERENT vendor's app card — foreign logo and name — which is worse than no
// hint at all. A re-shoot on a live portal never happened, so the owner asked to build the hint
// from OUR OWN assets instead: our real logo (public/icon-192.png — the same bytes the portal
// shows), our real app name and publisher. Nothing here imitates someone else's product or a real
// portal page pixel-for-pixel — it is a stylised sketch of OUR card whose only job is to point at
// the star row.
//
// Mechanics mirror make-og.mjs: an inline HTML template rendered by the pre-installed Chromium.
// The animation is NOT css-timed — the page exposes setFrame(i) and the script screenshots each
// deterministic state, so a re-run always produces the same frames. Assembly is pure JS
// (pngjs decode → gifenc quantize+LZW): the Playwright ffmpeg build is stripped (no PNG input,
// no GIF muxer), so it cannot do this. The GIF is a committed static asset (~ the old one was
// 506 KB / 320×204; we stay at that size class).
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { PNG } from 'pngjs'
import gifenc from 'gifenc'
import { resolveChromium } from './lib/chromium.mjs'

const { GIFEncoder, quantize, applyPalette } = gifenc

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'public', 'app-rating-demo.gif')
const W = 320
const H = 204
// Render 1:1. A 2× + downscale attempt double-transformed the cursor coordinates (rects are
// measured in visual pixels, styles land in the scaled space) and broke centering — at 320×204
// the 1× text is the same class of crispness the old capture had.
const SCALE = 1

const logo = `data:image/png;base64,${(await readFile(join(ROOT, 'public', 'icon-192.png'))).toString('base64')}`

// A stylised Market-card sketch: our logo, name, publisher, a big star row and the cursor that
// walks to the fifth star and clicks. Light surface (the Market is light), b24-ish blues.
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W * SCALE}px; height: ${H * SCALE}px; overflow: hidden; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; background: #eef2f4;
         display: flex; align-items: center; justify-content: center; }
  .card { width: ${(W - 24) * SCALE}px; background: #fff; border-radius: ${12 * SCALE}px;
          box-shadow: 0 ${2 * SCALE}px ${10 * SCALE}px rgba(83,92,105,.18); padding: ${14 * SCALE}px ${16 * SCALE}px; position: relative; }
  .head { display: flex; align-items: center; gap: ${10 * SCALE}px; }
  .head img { width: ${40 * SCALE}px; height: ${40 * SCALE}px; border-radius: ${9 * SCALE}px; }
  .title { font-size: ${13 * SCALE}px; font-weight: 700; color: #333; }
  .pub { font-size: ${9 * SCALE}px; color: #828b95; margin-top: ${2 * SCALE}px; }
  .hr { height: 1px; background: #edeef0; margin: ${11 * SCALE}px 0; }
  .label { font-size: ${9.5 * SCALE}px; color: #535c69; margin-bottom: ${6 * SCALE}px; }
  .stars { display: flex; gap: ${6 * SCALE}px; }
  .star { width: ${24 * SCALE}px; height: ${24 * SCALE}px; }
  .star path { fill: #d5dbe1; transition: none; }
  .star.on path { fill: #ffab00; }
  .star.pulse { transform: scale(1.18); transform-origin: center; }
  .thanks { position: absolute; right: ${14 * SCALE}px; bottom: ${12 * SCALE}px; font-size: ${9.5 * SCALE}px;
            font-weight: 600; color: #16a085; opacity: 0; }
  .thanks.show { opacity: 1; }
  #cursor { position: absolute; width: ${15 * SCALE}px; z-index: 5; filter: drop-shadow(0 ${1 * SCALE}px ${2 * SCALE}px rgba(0,0,0,.35)); }
</style></head><body>
  <div class="card" id="card">
    <div class="head">
      <img src="${logo}" alt="">
      <div><div class="title">AI-импорт прайсов</div><div class="pub">ИП Шевчик И.С. · Маркет Битрикс24</div></div>
    </div>
    <div class="hr"></div>
    <div class="label">Поставьте оценку приложению:</div>
    <div class="stars" id="stars"></div>
    <div class="thanks" id="thanks">Спасибо за оценку!</div>
  </div>
  <svg id="cursor" viewBox="0 0 24 24"><path d="M5 2 L19 13 L12.6 13.8 L16 21 L13.4 22 L10 15 L5 19 Z" fill="#fff" stroke="#333" stroke-width="1.6"/></svg>
  <script>
    const star = '<svg class="star" viewBox="0 0 24 24"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8Z"/></svg>'
    document.getElementById('stars').innerHTML = star.repeat(5)
    const stars = [...document.querySelectorAll('.star')]
    const cursor = document.getElementById('cursor')
    const thanks = document.getElementById('thanks')
    // Frame plan (24 frames):
    //  0-6   cursor flies in from bottom-right toward the first star
    //  7-15  cursor sweeps across the row; stars light up as it passes (hover feel)
    //  16    click on the 5th star (pulse)
    //  17-23 all five lit + «Спасибо за оценку!»; tail frames make the loop breathe
    window.setFrame = (i) => {
      const starAt = (n) => {
        const r = stars[n].getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }
      let pos
      if (i <= 6) {
        const t = i / 6
        const from = { x: ${W * SCALE} * 0.92, y: ${H * SCALE} * 0.94 }
        const to = starAt(0)
        pos = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
        stars.forEach(s => s.classList.remove('on', 'pulse'))
        thanks.classList.remove('show')
      } else if (i <= 15) {
        const t = (i - 7) / 8
        const a = starAt(0); const b = starAt(4)
        pos = { x: a.x + (b.x - a.x) * t, y: a.y }
        const lit = Math.min(4, Math.floor(t * 5))
        stars.forEach((s, n) => s.classList.toggle('on', n <= lit))
        stars.forEach(s => s.classList.remove('pulse'))
        thanks.classList.remove('show')
      } else {
        pos = starAt(4)
        stars.forEach(s => s.classList.add('on'))
        stars[4].classList.toggle('pulse', i === 16)
        thanks.classList.toggle('show', i >= 17)
      }
      cursor.style.left = pos.x + 'px'
      cursor.style.top = pos.y + 'px'
    }
  </script>
</body></html>`

const FRAMES = 24
// 8 fps reads calm (125 ms/frame); the tail frames above give a pause before the loop restarts.
const DELAY_MS = 125

const browser = await chromium.launch({ executablePath: await resolveChromium() })
const frames = []
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  for (let i = 0; i < FRAMES; i++) {
    await page.evaluate(n => window.setFrame(n), i)
    const shot = await page.screenshot({ type: 'png' })
    if (process.env.RATING_DEMO_DUMP) await writeFile(join(process.env.RATING_DEMO_DUMP, `f${String(i).padStart(2, '0')}.png`), shot)
    frames.push(PNG.sync.read(shot))
  }
} finally {
  await browser.close()
}

// One shared palette over ALL frames — per-frame palettes shimmer on flat UI colours.
const all = new Uint8Array(frames.length * W * H * 4)
frames.forEach((f, i) => all.set(f.data, i * W * H * 4))
const palette = quantize(all, 256)
const gif = GIFEncoder()
for (const f of frames) {
  gif.writeFrame(applyPalette(new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.length), palette), W, H, { palette, delay: DELAY_MS })
}
gif.finish()
await writeFile(OUT, gif.bytes())
const size = (await stat(OUT)).size
console.log(`✓ ${OUT.replace(ROOT, '.')} (${W}×${H}, ${FRAMES} frames, ${(size / 1024).toFixed(0)} KB)`)
if (size > 600 * 1024) throw new Error('GIF is heavier than the old one (506 KB) — tune quantization/frames')
