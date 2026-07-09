// Pure, hardened extraction of the final JSON object from the agent's stdout.
// DoS-bounded. FORWARD scan (escapes can only be resolved left-to-right — a '"' is
// escaped iff an odd run of '\' precedes it, which a backward scan gets wrong).

const MAX_OUTPUT_CHARS = 2_000_000

/** Extract the LAST balanced top-level JSON object that parses, or null. */
export function extractJson(output: string): unknown {
  if (!output || output.length > MAX_OUTPUT_CHARS) return null

  const spans: Array<[number, number]> = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < output.length; i++) {
    const ch = output[i]!
    if (inStr) {
      if (esc) {
        esc = false
      } else if (ch === '\\') {
        esc = true
      } else if (ch === '"') {
        inStr = false
      }
      continue
    }
    if (ch === '"') {
      inStr = true
    } else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start >= 0) spans.push([start, i])
      }
    }
  }

  // Prefer the last complete top-level object; fall back to earlier ones if it fails to parse.
  for (let s = spans.length - 1; s >= 0; s--) {
    try {
      return JSON.parse(output.slice(spans[s]![0], spans[s]![1] + 1))
    } catch {
      // try an earlier span
    }
  }
  return null
}
