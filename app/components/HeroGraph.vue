<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

// Hero background canvas: outer nodes (документы/банки/CRM) send pulses toward a
// central Bitrix24 hub. Client-only. Respects prefers-reduced-motion (static frame),
// pauses off-screen / on hidden tab, throttles to ~30fps. Pure decoration (aria-hidden).

const canvas = ref<HTMLCanvasElement | null>(null)
let raf = 0
let running = false
let last = 0
let io: IntersectionObserver | null = null
let visible = true

interface Node { x: number, y: number, r: number }
const NODES = 7
let nodes: Node[] = []
let pulses: Array<{ i: number, t: number, speed: number }> = []

function seed(w: number, h: number) {
  nodes = Array.from({ length: NODES }, (_, i) => {
    const a = (i / NODES) * Math.PI * 2
    return { x: w / 2 + Math.cos(a) * (w * 0.34), y: h / 2 + Math.sin(a) * (h * 0.36), r: 3 + (i % 3) }
  })
  pulses = nodes.map((_, i) => ({ i, t: (i / NODES), speed: 0.006 + (i % 4) * 0.0015 }))
}

function draw(w: number, h: number, animate: boolean) {
  const ctx = canvas.value?.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, w, h)
  const hx = w / 2
  const hy = h / 2

  // spokes
  ctx.lineWidth = 1
  for (const n of nodes) {
    ctx.strokeStyle = 'rgba(34,211,238,0.14)'
    ctx.beginPath()
    ctx.moveTo(n.x, n.y)
    ctx.lineTo(hx, hy)
    ctx.stroke()
    ctx.fillStyle = 'rgba(148,163,184,0.55)'
    ctx.beginPath()
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
    ctx.fill()
  }

  // travelling pulses toward the hub
  for (const p of pulses) {
    if (animate) p.t = (p.t + p.speed) % 1
    const n = nodes[p.i]!
    const x = n.x + (hx - n.x) * p.t
    const y = n.y + (hy - n.y) * p.t
    ctx.fillStyle = 'rgba(34,211,238,0.9)'
    ctx.beginPath()
    ctx.arc(x, y, 2.2, 0, Math.PI * 2)
    ctx.fill()
  }

  // central hub
  ctx.fillStyle = 'rgba(34,211,238,0.9)'
  ctx.beginPath()
  ctx.arc(hx, hy, 6, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(34,211,238,0.35)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(hx, hy, 12, 0, Math.PI * 2)
  ctx.stroke()
}

function frame(now: number) {
  if (!running) return
  if (now - last >= 33 && visible) { // ~30fps
    last = now
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
  seed(el.width, el.height)
}

onMounted(() => {
  if (typeof window === 'undefined' || !canvas.value) return
  size()
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (reduce) {
    draw(canvas.value.width, canvas.value.height, false) // single static frame
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

function onVis() {
  visible = document.visibilityState === 'visible'
}

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
