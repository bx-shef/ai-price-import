// Cross-script homoglyph folding for robust matching of articles / numbers /
// keywords typed in mixed Cyrillic/Latin. Pure, no I/O.
//
// We fold only UNAMBIGUOUS lower-case Russian-Cyrillic → Latin look-alikes.
// Borderline lower-case pairs (к/k, м/m, т/t, н/h, в/b) are intentionally NOT
// folded — in lower case they are not truly identical and folding them would
// corrupt common words. ALL Kazakh-distinctive letters (ә ғ қ ң ө ұ ү һ і) are
// preserved as-is — including і (U+0456) and һ (U+04BB) — so that Kazakh words /
// articles / keywords are not corrupted (docs/redesign/06-multilingual.md §5).

/** Russian Cyrillic letter → canonical Latin look-alike (lower-case domain). */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', ј: 'j', ѕ: 's'
}

/**
 * Fold a string to a canonical comparison form: lower-cased, unambiguous
 * cross-script look-alikes mapped to Latin. Kazakh-distinctive letters survive.
 */
export function foldHomoglyphs(input: string): string {
  const lower = input.toLowerCase()
  let out = ''
  for (const ch of lower) {
    out += CYRILLIC_TO_LATIN[ch] ?? ch
  }
  return out
}

/** True when two strings are equal after homoglyph folding + trimming. */
export function homoglyphEqual(a: string, b: string): boolean {
  return foldHomoglyphs(a.trim()) === foldHomoglyphs(b.trim())
}
