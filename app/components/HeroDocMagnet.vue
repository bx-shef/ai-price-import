<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

// Hero background canvas (L7, variant 2 — «Магнит Bitrix24»): document icons
// (накладная/счёт/КП/прайс) drift on inward-spiralling orbits around a central
// Bitrix24 hub, which pulls them in like a magnet; each absorbed document emits a
// ring pulse and respawns at the outer edge. The story: every document is drawn
// into your Bitrix24. Client-only, pure decoration (aria-hidden). Respects
// prefers-reduced-motion (single static frame), pauses off-screen (IntersectionObserver)
// and on a hidden tab (visibilitychange) via two independent flags, throttles ~30fps.

const canvas = ref<HTMLCanvasElement | null>(null)
let raf = 0
let running = false
let last = 0
let io: IntersectionObserver | null = null
// Two independent pause conditions — separate flags so neither clobbers the other.
let onScreen = true
let tabVisible = true

const CYAN = '34,211,238'
const SLATE = '148,163,184'

interface Doc { angle: number, radius: number, spin: number, ecc: number, rows: number }
interface Ring { t: number }
const COUNT = 6
let docs: Doc[] = []
let rings: Ring[] = []

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Fresh document at the outer edge with a randomised orbit (respawn after absorption). */
function spawn(i: number): Doc {
  return {
    angle: Math.random() * Math.PI * 2,
    radius: 0.9 + Math.random() * 0.12,
    spin: (0.18 + Math.random() * 0.22) * (i % 2 ? 1 : -1), // alternate orbit direction
    ecc: 0.85 + Math.random() * 0.3,
    rows: 3 + (i % 2)
  }
}

function seed() {
  docs = Array.from({ length: COUNT }, (_, i) => {
    const d = spawn(i)
    d.radius = 0.25 + (i / COUNT) * 0.7 // spread across radii so the loop starts full
    return d
  })
  rings = []
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** A small document glyph centred at (cx,cy), scaled + faded by `scale`/`alpha`. */
function drawDoc(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number, alpha: number, rows: number, base: number) {
  const w = base * scale
  const h = w * 1.3
  const x = cx - w / 2
  const y = cy - h / 2
  ctx.globalAlpha = alpha
  ctx.fillStyle = `rgba(${SLATE},0.12)`
  roundRect(ctx, x, y, w, h, w * 0.12)
  ctx.fill()
  ctx.strokeStyle = `rgba(${SLATE},0.34)`
  ctx.lineWidth = 1
  roundRect(ctx, x, y, w, h, w * 0.12)
  ctx.stroke()
  // header tab (cyan accent) + text lines
  const pad = w * 0.16
  ctx.fillStyle = `rgba(${CYAN},0.4)`
  roundRect(ctx, x + pad, y + h * 0.14, w * 0.42, Math.max(1.5, h * 0.05), 2)
  ctx.fill()
  ctx.fillStyle = `rgba(${SLATE},0.38)`
  for (let r = 0; r < rows; r++) {
    roundRect(ctx, x + pad, y + h * (0.34 + r * 0.16), w - pad * 2, Math.max(1, h * 0.035), 1.5)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

function drawHub(ctx: CanvasRenderingContext2D, hx: number, hy: number, base: number) {
  // Bitrix24 hub: a rounded-square badge with a halo; rings expand outfrom it on arrivals.
  for (const ring of rings) {
    const rr = base * 0.7 + ring.t * base * 2.4
    ctx.strokeStyle = `rgba(${CYAN},${0.4 * (1 - ring.t)})`
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(hx, hy, rr, 0, Math.PI * 2)
    ctx.stroke()
  }
  const s = base * 0.9
  ctx.strokeStyle = `rgba(${CYAN},0.28)`
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(hx, hy, s * 1.5, 0, Math.PI * 2)
  ctx.stroke()
  ctx.fillStyle = `rgba(${CYAN},0.95)`
  roundRect(ctx, hx - s / 2, hy - s / 2, s, s, s * 0.28)
  ctx.fill()
}

function draw(w: number, h: number, dt: number) {
  const ctx = canvas.value?.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, w, h)
  const hx = w / 2
  const hy = h / 2
  const rx = w * 0.42
  const ry = h * 0.42
  const base = Math.max(14, Math.min(w, h) * 0.06) // glyph/hub size

  // advance rings
  for (const ring of rings) ring.t = clamp01(ring.t + dt / 0.9)
  rings = rings.filter(r => r.t < 1)

  for (let i = 0; i < docs.length; i++) {
    const d = docs[i]!
    if (dt > 0) {
      d.angle += d.spin * dt
      d.radius -= dt * 0.06 // slow inward pull (magnet)
    }
    if (d.radius <= 0.12) {
      rings.push({ t: 0 }) // absorbed → ring pulse + respawn
      docs[i] = spawn(i)
      continue
    }
    const cx = hx + Math.cos(d.angle) * rx * d.radius * d.ecc
    const cy = hy + Math.sin(d.angle) * ry * d.radius
    const near = clamp01((d.radius - 0.12) / 0.25) // 0 at hub, 1 further out
    const scale = 0.45 + 0.55 * clamp01(d.radius) // shrink as it approaches
    const alpha = 0.25 + 0.6 * near // fade into the hub
    // faint tether toward the hub
    ctx.strokeStyle = `rgba(${CYAN},${0.08 * near})`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(hx, hy)
    ctx.stroke()
    drawDoc(ctx, cx, cy, scale, alpha, d.rows, base)
  }

  drawHub(ctx, hx, hy, base)
}

function frame(now: number) {
  if (!running) return
  if (now - last >= 33 && onScreen && tabVisible) { // ~30fps
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0
    last = now
    const el = canvas.value
    if (el) draw(el.width, el.height, dt)
  }
  raf = requestAnimationFrame(frame)
}

function size() {
  const el = canvas.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  el.width = Math.max(1, Math.floor(rect.width))
  el.height = Math.max(1, Math.floor(rect.height))
}

function onVis() {
  tabVisible = document.visibilityState === 'visible'
}

onMounted(() => {
  if (typeof window === 'undefined' || !canvas.value) return
  size()
  seed()
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (reduce) {
    draw(canvas.value.width, canvas.value.height, 0) // single static frame
    return
  }
  running = true
  raf = requestAnimationFrame(frame)
  window.addEventListener('resize', size)
  document.addEventListener('visibilitychange', onVis)
  io = new IntersectionObserver((entries) => {
    onScreen = !!entries[0]?.isIntersecting
  }, { threshold: 0 })
  io.observe(canvas.value)
})

onBeforeUnmount(() => {
  running = false
  cancelAnimationFrame(raf)
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', size)
    document.removeEventListener('visibilitychange', onVis)
  }
  io?.disconnect()
})
</script>

<template>
  <canvas
    ref="canvas"
    class="h-full w-full"
    aria-hidden="true"
  />
</template>
