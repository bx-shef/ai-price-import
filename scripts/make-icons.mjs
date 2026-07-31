// Generate the full favicon bundle from the single master public/favicon.svg (#298).
// Run when the logo changes:  pnpm icons
//
// One source → every derived asset, so the tab icon, the home-screen icon and the PWA
// manifest can never drift apart. Rasterisation goes through the pre-installed Chromium
// (same resolver as make-og.mjs / screenshot.mjs) — no native image deps in the repo.
//
// Outputs (committed static assets):
//   favicon.ico            16+32+48 (PNG-in-ICO — valid since Vista, accepted by every
//                          modern browser; classic BMP entries would triple the size)
//   favicon-16.png/-32.png explicit small sizes for browsers that prefer PNG links
//   apple-touch-icon.png   180×180, opaque (iOS composites transparency onto black)
//   icon-192.png/-512.png  PWA/manifest sizes
//   icon-maskable-512.png  512 with the safe-zone margin (icon content in the inner 80%)
//   site.webmanifest       names + icon list (theme colours match the logo backdrop)
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { resolveChromium } from './lib/chromium.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PUB = join(ROOT, 'public')

/** Sizes for the plain (full-bleed) icon renders. */
const PLAIN = [16, 32, 48, 180, 192, 512]

/** Render the SVG at `size`, optionally scaled down inside the canvas (maskable safe zone). */
async function render(page, svg, size, { scale = 1, background = 'transparent' } = {}) {
  const inner = Math.round(size * scale)
  const offset = Math.round((size - inner) / 2)
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; } body { width: ${size}px; height: ${size}px; background: ${background}; }
    img { position: absolute; left: ${offset}px; top: ${offset}px; width: ${inner}px; height: ${inner}px; }
  </style></head><body><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(html, { waitUntil: 'load' })
  return page.screenshot({ type: 'png', omitBackground: background === 'transparent', clip: { x: 0, y: 0, width: size, height: size } })
}

/** Pack PNG buffers into a single .ico (PNG-in-ICO container). */
function packIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dirs = []
  let offset = 6 + entries.length * 16
  for (const { size, png } of entries) {
    const d = Buffer.alloc(16)
    d.writeUInt8(size === 256 ? 0 : size, 0) // width (0 = 256)
    d.writeUInt8(size === 256 ? 0 : size, 1) // height
    d.writeUInt8(0, 2) // palette
    d.writeUInt8(0, 3) // reserved
    d.writeUInt16LE(1, 4) // planes
    d.writeUInt16LE(32, 6) // bpp
    d.writeUInt32LE(png.length, 8)
    d.writeUInt32LE(offset, 12)
    dirs.push(d)
    offset += png.length
  }
  return Buffer.concat([header, ...dirs, ...entries.map(e => e.png)])
}

const svg = await readFile(join(PUB, 'favicon.svg'), 'utf8')
const browser = await chromium.launch({ executablePath: await resolveChromium() })
try {
  await mkdir(PUB, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 })

  const rendered = new Map()
  for (const size of PLAIN) rendered.set(size, await render(page, svg, size))

  await writeFile(join(PUB, 'favicon-16.png'), rendered.get(16))
  await writeFile(join(PUB, 'favicon-32.png'), rendered.get(32))
  await writeFile(join(PUB, 'icon-192.png'), rendered.get(192))
  await writeFile(join(PUB, 'icon-512.png'), rendered.get(512))
  // iOS home screen: opaque background (the logo's own dark backdrop fills the corners).
  await writeFile(join(PUB, 'apple-touch-icon.png'), await render(page, svg, 180, { background: '#0b1220' }))
  // Maskable: content inside the inner 80% so any platform mask (circle/squircle) keeps it whole.
  await writeFile(join(PUB, 'icon-maskable-512.png'), await render(page, svg, 512, { scale: 0.8, background: '#0b1220' }))

  await writeFile(join(PUB, 'favicon.ico'), packIco([
    { size: 16, png: rendered.get(16) },
    { size: 32, png: rendered.get(32) },
    { size: 48, png: rendered.get(48) }
  ]))

  await writeFile(join(PUB, 'site.webmanifest'), `${JSON.stringify({
    name: 'AI-импорт прайсов в Bitrix24',
    short_name: 'AI-импорт',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ],
    theme_color: '#0b1220',
    background_color: '#0b1220',
    display: 'browser'
  }, null, 2)}\n`)

  console.log('✓ favicon.ico, favicon-16/32.png, apple-touch-icon.png, icon-192/512.png, icon-maskable-512.png, site.webmanifest')
} finally {
  await browser.close()
}
