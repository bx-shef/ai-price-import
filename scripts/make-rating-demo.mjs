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
// Rendered 1:1 — a 2×+downscale attempt double-transformed the cursor coordinates (rects are
// measured in visual pixels, styles land in the scaled space); at 320×204 the 1× text is the
// same class of crispness the old capture had.

const logo = `data:image/png;base64,${(await readFile(join(ROOT, 'public', 'icon-192.png'))).toString('base64')}`

// A stylised sketch of the REAL Market app-card layout (owner reference 2026-08-04: header with
// logo + Uninstall/Open buttons, then the RATING / INSTALLATIONS / DEVELOPER / CATEGORY stat row,
// screenshots strip below) — with OUR logo, name and publisher. The cursor walks to the stars in
// the «Оценка» column and sets the fifth one.
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; background: #fff; }
  .head { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px 10px; }
  .head img { width: 44px; height: 44px; border-radius: 8px; }
  .title { font-size: 12px; font-weight: 700; color: #333; }
  .sub { font-size: 8px; color: #828b95; margin-top: 2px; }
  .btns { display: flex; align-items: center; gap: 6px; margin-top: 7px; }
  .btn { font-size: 7px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
         border: 1px solid #d5dbe1; border-radius: 12px; padding: 3px 9px; color: #333; }
  .btn.dark { background: #333; border-color: #333; color: #fff; }
  .iap { font-size: 7px; color: #828b95; margin-left: 4px; }
  .statrow { display: flex; border-top: 1px solid #edeef0; border-bottom: 1px solid #edeef0; }
  .stat { flex: 1; padding: 8px 6px 9px; text-align: center; border-right: 1px solid #edeef0; }
  .stat:last-child { border-right: none; }
  .stat .cap { font-size: 6.5px; font-weight: 700; letter-spacing: .08em; color: #a8adb4;
               text-transform: uppercase; margin-bottom: 4px; }
  .stat .val { font-size: 9px; font-weight: 600; color: #333; }
  .stars { display: flex; gap: 2px; justify-content: center; }
  .star { width: 11px; height: 11px; }
  .star path { fill: #d5dbe1; }
  .star.on path { fill: #ffab00; }
  .star.pulse { transform: scale(1.25); transform-origin: center; }
  .norate { font-size: 8px; color: #a8adb4; margin-top: 1px; }
  .thanks { font-size: 7px; font-weight: 600; color: #16a085; margin-top: 3px; opacity: 0; }
  .thanks.show { opacity: 1; }
  .shots { display: flex; gap: 8px; padding: 10px 14px; }
  .shot { flex: 1; height: 52px; border-radius: 6px; border: 1px solid #edeef0; }
  .shot.dark { background: #1b1b29; position: relative; }
  .shot.dark::after { content: ''; position: absolute; left: 10px; top: 20px; width: 55%; height: 4px;
                      background: #3bd1bb; border-radius: 2px; }
  .shot.light { background: #f6f8f9; position: relative; }
  .shot.light::after { content: ''; position: absolute; left: 10px; top: 12px; width: 70%; height: 3px;
                       background: #d5dbe1; border-radius: 2px; box-shadow: 0 8px 0 #d5dbe1, 0 16px 0 #d5dbe1; }
  #cursor { position: absolute; width: 13px; z-index: 5; filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
</style></head><body>
  <div class="head">
    <img src="${logo}" alt="">
    <div>
      <div class="title">AI-импорт прайсов</div>
      <div class="sub">Накладные и счета — в CRM Битрикс24</div>
      <div class="btns"><span class="btn">Удалить</span><span class="btn dark">Открыть</span><span class="iap">· Маркет Битрикс24</span></div>
    </div>
  </div>
  <div class="statrow">
    <div class="stat">
      <div class="cap">Оценка</div>
      <div class="stars" id="stars"></div>
      <div class="norate" id="norate">нет оценок</div>
      <div class="thanks" id="thanks">Спасибо!</div>
    </div>
    <div class="stat"><div class="cap">Установки</div><div class="val">—</div></div>
    <div class="stat"><div class="cap">Разработчик</div><div class="val">ИП Шевчик И.С.</div></div>
    <div class="stat"><div class="cap">Категория</div><div class="val">Интеграции</div></div>
  </div>
  <div class="shots"><div class="shot dark"></div><div class="shot light"></div></div>
  <svg id="cursor" viewBox="0 0 24 24"><path d="M5 2 L19 13 L12.6 13.8 L16 21 L13.4 22 L10 15 L5 19 Z" fill="#fff" stroke="#333" stroke-width="1.6"/></svg>
  <script>
    const star = '<svg class="star" viewBox="0 0 24 24"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8Z"/></svg>'
    document.getElementById('stars').innerHTML = star.repeat(5)
    const stars = [...document.querySelectorAll('.star')]
    const cursor = document.getElementById('cursor')
    const thanks = document.getElementById('thanks')
    const norate = document.getElementById('norate')
    // Frame plan (24 frames):
    //  0-6   cursor flies in from the screenshots area up to the first star of «Оценка»
    //  7-15  cursor sweeps the row; stars light up as it passes
    //  16    click on the 5th star (pulse)
    //  17-23 all five lit + «Спасибо!»; tail frames make the loop breathe
    window.setFrame = (i) => {
      const starAt = (n) => {
        const r = stars[n].getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }
      let pos
      if (i <= 6) {
        const t = i / 6
        const from = { x: ${W} * 0.55, y: ${H} * 0.88 }
        const to = starAt(0)
        pos = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
        stars.forEach(s => s.classList.remove('on', 'pulse'))
        thanks.classList.remove('show')
        norate.style.display = ''
      } else if (i <= 15) {
        const t = (i - 7) / 8
        const a = starAt(0); const b = starAt(4)
        pos = { x: a.x + (b.x - a.x) * t, y: a.y }
        const lit = Math.min(4, Math.floor(t * 5))
        stars.forEach((s, n) => s.classList.toggle('on', n <= lit))
        stars.forEach(s => s.classList.remove('pulse'))
        thanks.classList.remove('show')
        norate.style.display = 'none'
      } else {
        pos = starAt(4)
        stars.forEach(s => s.classList.add('on'))
        stars[4].classList.toggle('pulse', i === 16)
        thanks.classList.toggle('show', i >= 17)
        norate.style.display = 'none'
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
