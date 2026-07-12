<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

// Hero background canvas (L7, variant 3 — «частичное поле»): a restrained parallax
// particle field. Small dots drift at speeds set by their depth layer; faint links
// appear between close particles and a few «flash» brighter on a slow cycle. No hub,
// no objects — deliberately calm. Client-only, pure decoration (aria-hidden). Respects
// prefers-reduced-motion (single static frame), pauses off-screen (IntersectionObserver)
// and on a hidden tab (visibilitychange) via two independent flags, throttles ~30fps.

const canvas = ref<HTMLCanvasElement | null>(null)
let raf = 0
let running = false
let last = 0
let io: IntersectionObserver | null = null
let onScreen = true
let tabVisible = true
let t = 0

const CYAN = '34,211,238'

interface P { x: number, y: number, vx: number, vy: number, depth: number, phase: number }
let ps: P[] = []
const LINK_DIST = 120

function rand(a: number, b: number) {
  return a + Math.random() * (b - a)
}

function seed(w: number, h: number) {
  // Density scales with area; capped so wide screens stay light.
  const count = Math.min(70, Math.max(24, Math.round((w * h) / 26000)))
  ps = Array.from({ length: count }, () => {
    const depth = rand(0.3, 1) // 0.3 far (small/dim/slow) → 1 near
    const speed = 4 + depth * 12 // px/s, parallax by depth
    const a = rand(0, Math.PI * 2)
    return {
      x: rand(0, w),
      y: rand(0, h),
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      depth,
      phase: rand(0, Math.PI * 2)
    }
  })
}

function draw(w: number, h: number, dt: number) {
  const ctx = canvas.value?.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, w, h)
  t += dt

  // advance + wrap
  for (const p of ps) {
    p.x += p.vx * dt
    p.y += p.vy * dt
    if (p.x < -4) p.x = w + 4
    else if (p.x > w + 4) p.x = -4
    if (p.y < -4) p.y = h + 4
    else if (p.y > h + 4) p.y = -4
  }

  // faint links between nearby particles; a slow cosine makes a few «flash».
  ctx.lineWidth = 1
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i]!
    for (let j = i + 1; j < ps.length; j++) {
      const b = ps[j]!
      const dx = a.x - b.x
      const dy = a.y - b.y
      const d2 = dx * dx + dy * dy
      if (d2 > LINK_DIST * LINK_DIST) continue
      const near = 1 - Math.sqrt(d2) / LINK_DIST
      // base faint link + occasional flash driven by the pair's combined phase
      const flash = Math.max(0, Math.cos(t * 0.8 + a.phase + b.phase))
      const alpha = near * (0.05 + 0.16 * flash * flash)
      if (alpha < 0.012) continue
      ctx.strokeStyle = `rgba(${CYAN},${alpha.toFixed(3)})`
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
  }

  // particles
  for (const p of ps) {
    const r = 0.6 + p.depth * 1.7
    ctx.fillStyle = `rgba(${CYAN},${(0.18 + p.depth * 0.45).toFixed(3)})`
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fill()
  }
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
  seed(el.width, el.height)
}

function onVis() {
  tabVisible = document.visibilityState === 'visible'
}

onMounted(() => {
  if (typeof window === 'undefined' || !canvas.value) return
  size()
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
