// Pure, hardened extraction of the final JSON object from the agent's stdout.
// DoS-bounded (ported concept from legacy). No I/O.

const MAX_OUTPUT_CHARS = 2_000_000

/** Extract the last balanced top-level JSON object from a text blob, or null. */
export function extractJson(output: string): unknown {
  if (!output || output.length > MAX_OUTPUT_CHARS) return null
  const end = output.lastIndexOf('}')
  if (end < 0) return null

  // Walk back from the last '}' to its matching '{', respecting strings/escapes.
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = end; i >= 0; i--) {
    const ch = output[i]!
    if (inStr) {
      if (esc) {
        esc = false
        continue
      }
      if (ch === '\\') {
        esc = true
        continue
      }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '}') {
      depth++
    } else if (ch === '{') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(output.slice(i, end + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}
