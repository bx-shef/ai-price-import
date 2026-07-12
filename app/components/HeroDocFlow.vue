<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

// Hero background canvas (L7): «Документ → строки CRM». Ghost documents drift in
// from the left, dissolve at a staging point, and their text-lines peel off into
// tidy row-cards that fly rightward and merge into a Bitrix24 hub (a ring pulses on
// arrival). This is the product's story — parsing a document into CRM rows — so it
// replaces the generic radial HeroGraph. Client-only, pure decoration (aria-hidden).
// Respects prefers-reduced-motion (single static frame), pauses off-screen / on a
// hidden tab, throttles to ~30fps. Positions are derived from each document's phase
// clock (no persistent particle pool) — cheap and deterministic.

const canvas = ref<HTMLCanvasElement | null>(null)
let raf = 0
let running = false
let last = 0
let io: IntersectionObserver | null = null
let visible = true
let clock = 0

const CYAN = '34,211,238'
const SLATE = '148,163,184'

// Three documents on a staggered loop; each has a lane (y), a phase offset, and a
// row count. Relative line offsets inside a document are fixed per row index.
interface Doc { lane: number, offset: number, rows: number }
const DOCS: Doc[] = [
  { lane: 0.30, offset: 0.00, rows: 4 },
  { lane: 0.52, offset: 0.40, rows: 3 },
  { lane: 0.74, offset: 0.72, rows: 4 }
]

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/**
 * Render one document's full lifecycle at phase `t` in [0,1]:
 *   A 0–0.30  slide in from the left edge to the staging x (fade in)
 *   B 0.30–0.45 hold at staging (the "reading" beat)
 *   C 0.45–0.88 rows peel off and fly to the hub (document fades out)
 *   D 0.88–1  quiet gap before the loop recycles
 */
function drawDoc(ctx: CanvasRenderingContext2D, w: number, h: number, doc: Doc, t: number, hubX: number, hubY: number) {
  const stageX = w * 0.28
  const docW = Math.min(w * 0.16, 112)
  const docH = docW * 1.3
  const laneY = h * doc.lane

  // Document body position + alpha.
  const slide = easeInOut(clamp01(t / 0.30))
  const docX = -docW + (stageX - -docW) * slide
  const inAlpha = clamp01(t / 0.18)
  const outAlpha = t < 0.45 ? 1 : 1 - clamp01((t - 0.45) / 0.30)
  const docAlpha = Math.min(inAlpha, outAlpha)
  const docTop = laneY - docH / 2

  // Row line geometry inside the document (evenly spaced, small top margin).
  const pad = docW * 0.14
  const lineY = (r: number) => docTop + docH * (0.28 + (r / doc.rows) * 0.6)

  if (docAlpha > 0.01) {
    ctx.globalAlpha = docAlpha * 0.9
    ctx.fillStyle = `rgba(${SLATE},0.10)`
    roundRect(ctx, docX, docTop, docW, docH, 8)
    ctx.fill()
    ctx.strokeStyle = `rgba(${SLATE},0.30)`
    ctx.lineWidth = 1
    roundRect(ctx, docX, docTop, docW, docH, 8)
    ctx.stroke()
    // header tab
    ctx.fillStyle = `rgba(${CYAN},0.35)`
    roundRect(ctx, docX + pad, docTop + docH * 0.12, docW * 0.4, 4, 2)
    ctx.fill()
    // ghost text-lines (those not yet peeled)
    for (let r = 0; r < doc.rows; r++) {
      const peel = clamp01((t - 0.45) / 0.40 - r * 0.06)
      if (peel > 0) continue // this line has left the document
      ctx.fillStyle = `rgba(${SLATE},0.35)`
      roundRect(ctx, docX + pad, lineY(r), docW - pad * 2, 3, 1.5)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  // Phase C: rows fly from the staging line positions to the hub, staggered.
  let arrivalLead = 0
  for (let r = 0; r < doc.rows; r++) {
    const rp = clamp01((t - 0.45) / 0.40 - r * 0.06)
    if (rp <= 0) continue
    arrivalLead = Math.max(arrivalLead, rp)
    const e = easeInOut(rp)
    const sx = stageX + pad
    const sy = lineY(r)
    const x = sx + (hubX - sx) * e
    const y = sy + (hubY - sy) * e
    const rowW = (docW - pad * 2) * (1 - 0.55 * rp) // shrink as it converges
    const alpha = rp < 0.85 ? 0.85 : 0.85 * (1 - (rp - 0.85) / 0.15)
    ctx.globalAlpha = clamp01(alpha)
    ctx.fillStyle = `rgba(${CYAN},0.9)`
    roundRect(ctx, x, y - 1.5, Math.max(4, rowW), 3, 1.5)
    ctx.fill()
    ctx.globalAlpha = 1
  }
  return arrivalLead
}

function drawHub(ctx: CanvasRenderingContext2D, hubX: number, hubY: number, ring: number) {
  // Bitrix24 hub: solid core + steady halo, plus an expanding ring on each arrival.
  if (ring > 0) {
    const rr = 12 + ring * 26
    ctx.strokeStyle = `rgba(${CYAN},${0.45 * (1 - ring)})`
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(hubX, hubY, rr, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.strokeStyle = `rgba(${CYAN},0.30)`
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(hubX, hubY, 13, 0, Math.PI * 2)
  ctx.stroke()
  ctx.fillStyle = `rgba(${CYAN},0.95)`
  ctx.beginPath()
  ctx.arc(hubX, hubY, 6, 0, Math.PI * 2)
  ctx.fill()
}

function draw(w: number, h: number, animate: boolean) {
  const ctx = canvas.value?.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, w, h)
  const hubX = w * 0.82
  const hubY = h * 0.5

  // faint conveyor track from the staging column to the hub
  ctx.strokeStyle = `rgba(${SLATE},0.10)`
  ctx.lineWidth = 1
  ctx.setLineDash([4, 6])
  ctx.beginPath()
  ctx.moveTo(w * 0.28, hubY)
  ctx.lineTo(hubX, hubY)
  ctx.stroke()
  ctx.setLineDash([])

  let ring = 0
  for (const doc of DOCS) {
    const t = (clock + doc.offset) % 1
    const lead = drawDoc(ctx, w, h, doc, animate ? t : Math.max(t, 0.6), hubX, hubY)
    // a ring fires as the leading row of a document reaches the hub (rp ~0.85→1)
    if (lead > 0.85) ring = Math.max(ring, (lead - 0.85) / 0.15)
  }
  drawHub(ctx, hubX, hubY, ring)
}

function frame(now: number) {
  if (!running) return
  if (now - last >= 33 && visible) { // ~30fps
    const dt = last ? (now - last) / 1000 : 0
    last = now
    clock = (clock + dt * 0.12) % 1 // ~8.3s per document loop
    const el = canvas.value
    if (el) draw(el.width, el.height, true)
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
  visible = document.visibilityState === 'visible'
}

onMounted(() => {
  if (typeof window === 'undefined' || !canvas.value) return
  size()
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (reduce) {
    clock = 0.62 // a representative mid-flight frame (rows en route to the hub)
    draw(canvas.value.width, canvas.value.height, false)
    return
  }
  running = true
  raf = requestAnimationFrame(frame)
  window.addEventListener('resize', size)
  document.addEventListener('visibilitychange', onVis)
  io = new IntersectionObserver((entries) => {
    visible = !!entries[0]?.isIntersecting
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
