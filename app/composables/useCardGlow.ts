/**
 * Feeds cursor coordinates into CSS vars --glow-x/--glow-y for [data-glow-card]
 * elements — a mouse-following glow (see main.css). Cleared on leave so the glow
 * doesn't jump to the last position on the next hover. Ported from client-bank.
 */
export function useCardGlow(): void {
  const handleMove = (e: MouseEvent) => {
    const target = (e.target as Element | null)?.closest('[data-glow-card]') as HTMLElement | null
    if (!target) return
    const r = target.getBoundingClientRect()
    target.style.setProperty('--glow-x', `${e.clientX - r.left}px`)
    target.style.setProperty('--glow-y', `${e.clientY - r.top}px`)
  }

  const handleLeave = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (!target?.matches?.('[data-glow-card]')) return
    if (target.contains(e.relatedTarget as Node | null)) return // moved onto a child
    target.style.removeProperty('--glow-x')
    target.style.removeProperty('--glow-y')
  }

  onMounted(() => {
    document.addEventListener('mousemove', handleMove, { passive: true })
    document.addEventListener('mouseout', handleLeave, { passive: true })
  })

  onUnmounted(() => {
    document.removeEventListener('mousemove', handleMove)
    document.removeEventListener('mouseout', handleLeave)
  })
}
