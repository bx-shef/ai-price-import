// Cross-script homoglyph folding for robust matching of articles / numbers /
// keywords typed in mixed Cyrillic/Latin. Pure, no I/O.
//
// IMPORTANT (docs/redesign/06-multilingual.md §5): we fold only CROSS-SCRIPT
// look-alikes (Cyrillic ↔ Latin). Kazakh-specific Cyrillic letters
// (ә ғ қ ң ө ұ ү һ і) that have no Latin twin are preserved as-is — we must NOT
// collapse қ→к, ө→о, etc. Only і→i and һ→h have Latin twins and are folded.

/** Cyrillic letter → canonical Latin look-alike (lower-case domain). */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p',
  с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԛ: 'q', ԝ: 'w'
}

/**
 * Fold a string to a canonical comparison form: lower-cased, cross-script
 * look-alikes mapped to Latin. Kazakh letters without a Latin twin survive.
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
