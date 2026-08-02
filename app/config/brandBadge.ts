// Resolved visual tokens of the brand pill (BrandBadge.vue) as PLAIN CSS VALUES.
//
// Why a second representation exists (#329): the badge lives in two worlds. On the landing it is a
// Vue component styled with Tailwind classes; on the share card (`scripts/make-og.mjs`) it is inline
// HTML rendered by headless Chromium, which cannot import a Vue component or run Tailwind. Before
// this module the card wore a flat text eyebrow instead — a different mark for the same thing.
//
// Tailwind class names cannot be composed from runtime values (the JIT scans literal source text),
// so the component keeps its literal classes and this module mirrors them. That mirroring is the
// drift risk, so it is PINNED BY A TEST (tests/brandBadge.test.ts) that reads BrandBadge.vue and
// asserts every class here is actually present — editing one side alone fails CI. Same discipline
// as the nginx.conf ↔ edgeSecurity.ts CSP parity test.
export const BRAND_BADGE = {
  /** border-cyan-400/40 — Tailwind v4 palette is oklch, and the `/40` alpha compiles to color-mix
   *  in oklab. The v3 hex (#22d3ee) is a DIFFERENT, less saturated colour: decoding it that way made
   *  the card's badge visibly duller than the landing's — exactly the drift this module prevents. */
  borderColor: 'color-mix(in oklab, oklch(78.9% 0.154 211.53) 40%, transparent)',
  /** bg-cyan-400/10 */
  background: 'color-mix(in oklab, oklch(78.9% 0.154 211.53) 10%, transparent)',
  /** rounded-md */
  radiusPx: 6,
  /** px-3 py-1.5 */
  paddingXPx: 12,
  paddingYPx: 6,
  /** gap-2 */
  gapPx: 8,
  /** text-[14px] font-bold text-cyan-300 */
  brandSizePx: 14,
  brandWeight: 700,
  brandColor: 'oklch(86.5% 0.127 207.078)',
  /** text-[10px] font-semibold uppercase tracking-[0.14em] text-white/70 */
  captionSizePx: 10,
  captionWeight: 600,
  captionColor: 'rgba(255,255,255,0.7)',
  captionTrackingEm: 0.14
} as const

/** Tailwind classes the component must carry for the values above to be truthful (test asserts). */
export const BRAND_BADGE_CLASSES = [
  'inline-flex',
  'items-center',
  'rounded-md',
  'border-cyan-400/40',
  'bg-cyan-400/10',
  'px-3',
  'py-1.5',
  'gap-2',
  'text-[14px]',
  'font-bold',
  'leading-none',
  'text-cyan-300',
  'text-[10px]',
  'font-semibold',
  'uppercase',
  'tracking-[0.14em]',
  'text-white/70'
] as const

/**
 * Inline CSS + markup for the badge, scaled for a canvas where 14px would be unreadable (the OG
 * card is 1200×630 and its title is 76px). `scale` multiplies every geometric token; colours and
 * weights are scale-invariant. Returns a self-contained `<span>` — no stylesheet needed.
 */
export function brandBadgeHtml(brand: string, caption: string, scale = 1): string {
  const b = BRAND_BADGE
  const px = (n: number) => `${Math.round(n * scale)}px`
  return `<span style="display:inline-flex;align-items:center;gap:${px(b.gapPx)};`
    + `border:1px solid ${b.borderColor};background:${b.background};border-radius:${px(b.radiusPx)};`
    + `padding:${px(b.paddingYPx)} ${px(b.paddingXPx)}">`
    + `<span style="font-size:${px(b.brandSizePx)};font-weight:${b.brandWeight};line-height:1;color:${b.brandColor}">${brand}</span>`
    + `<span style="font-size:${px(b.captionSizePx)};font-weight:${b.captionWeight};text-transform:uppercase;`
    + `letter-spacing:${b.captionTrackingEm}em;color:${b.captionColor}">${caption}</span>`
    + '</span>'
}
