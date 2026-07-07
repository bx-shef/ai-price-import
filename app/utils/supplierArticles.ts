import type { ArticleFieldConfig } from '~/types/mapping'
import { foldHomoglyphs } from './homoglyph'

/**
 * Parse the supplier-article field value of a catalog product into a normalised
 * set of articles. One product may carry several supplier articles in one field:
 *  - kind 'text'   → each article on its own line;
 *  - kind 'string' → articles joined by an admin-chosen delimiter.
 * Values are trimmed, empties dropped, deduped by homoglyph-folded form.
 * See docs/redesign/02-target-architecture.md §5.
 */
export function parseSupplierArticles(value: string, cfg: ArticleFieldConfig): string[] {
  if (!value) return []
  const parts = cfg.kind === 'text'
    ? value.split(/\r?\n/)
    : value.split(cfg.delimiter && cfg.delimiter.length ? cfg.delimiter : ',')

  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of parts) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const key = foldHomoglyphs(trimmed)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

/** True when a document article matches any of the product's articles (homoglyph-tolerant). */
export function articleMatches(documentArticle: string, productArticles: string[]): boolean {
  const target = foldHomoglyphs(documentArticle.trim())
  if (!target) return false
  return productArticles.some(a => foldHomoglyphs(a.trim()) === target)
}
