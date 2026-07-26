// A dependency-free RFC 4122 v4 UUID generator with graceful fallbacks. Needed because the import
// idempotency key MUST be a real UUID: the server validates it against a strict UUID regex and, on a
// non-UUID, mints its OWN id — which would desync the client's up-front job record (invisible import)
// and break crm-sync's stable-key idempotency (duplicate CRM entities). `crypto.randomUUID` is absent
// in NON-secure contexts (an on-prem Bitrix24 over plain http — a supported self-hosted target), so a
// naive `Date.now()`-based fallback shipped a non-UUID. This always returns a UUID-shaped string.

/** Format 16 random bytes as an RFC 4122 v4 UUID (sets the version/variant nibbles). */
function bytesToUuidV4(b: Uint8Array): string {
  b[6] = (b[6]! & 0x0f) | 0x40 // version 4
  b[8] = (b[8]! & 0x3f) | 0x80 // variant 10xx
  const h: string[] = []
  for (let i = 0; i < 16; i++) h.push(b[i]!.toString(16).padStart(2, '0'))
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`
}

/**
 * Return a valid v4 UUID. Prefers `crypto.randomUUID`, then `crypto.getRandomValues` (both real CSPRNGs),
 * and only as a last resort a `Math.random` fill (still UUID-shaped so it passes server validation).
 */
export function uuidv4(): string {
  const c = typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined
  if (c?.randomUUID) return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (c?.getRandomValues) {
    c.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return bytesToUuidV4(bytes)
}
