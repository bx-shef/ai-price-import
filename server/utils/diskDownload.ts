import type { RestCall } from './b24Rest'

// Download a portal Disk file's BYTES (for #332: attach the source document to a feedback issue as a
// real file, not a portal-internal link the publisher can't open). Pure core over an injected RestCall
// so the runtime uses the per-portal OAuth frame token (makeBareTokenSdkCall) while the live test drives
// it through the webhook — same REST method (`disk.file.get`), different transport. Best-effort: any
// benign miss returns null and the caller just files the issue without the file.

/** Binary fetch exposing the response BODY as a byte stream (so we cap size WHILE reading, never
 *  buffering an unbounded body into RAM). Prod passes a redirect:'manual' + timeout globalThis.fetch;
 *  tests a fake. `body` is null on a non-body / redirect / error response. */
export type BinaryFetchFn = (url: string) => Promise<{ ok: boolean, status: number, body: AsyncIterable<Uint8Array> | null }>

export interface DownloadedFile { name: string, base64: string, size: number }

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 // 5 MB — invoices are small; cap protects our RAM + the repo

/** Lowercase host of a URL, or '' if unparseable. */
function urlHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

/** Normalise a portal domain ("PORTAL.bitrix24.by/", "https://x/") to a bare lowercase host. */
function portalHost(domain: string): string {
  return domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim().toLowerCase()
}

/**
 * Download a Disk file as base64 via `disk.file.get` → `DOWNLOAD_URL`.
 * @param fileId       Disk file id (from the job's stored diskFile ref).
 * @param portalDomain the portal host — the DOWNLOAD_URL host MUST equal it (SSRF guard: the URL comes
 *                     from a REST response, so a hostile/compromised portal must not make our server
 *                     fetch an arbitrary host).
 * Returns null on any benign miss (bad id / missing file / no url / wrong host / too large / non-200 /
 * empty) — attaching a file is best-effort and must never fail the feedback submission.
 */
export async function downloadDiskFile(
  fileId: number,
  portalDomain: string,
  call: RestCall,
  fetchFn: BinaryFetchFn,
  opts: { maxBytes?: number } = {}
): Promise<DownloadedFile | null> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isInteger(fileId) || fileId <= 0) return null
  const host = portalHost(portalDomain)
  if (!host) return null
  const info = await call('disk.file.get', { id: fileId }) as { NAME?: unknown, SIZE?: unknown, DOWNLOAD_URL?: unknown } | null
  const url = typeof info?.DOWNLOAD_URL === 'string' ? info.DOWNLOAD_URL : ''
  if (!url || urlHost(url) !== host) return null // SSRF guard: only fetch from the portal itself
  const declared = Number(info?.SIZE)
  if (Number.isFinite(declared) && declared > maxBytes) return null
  const res = await fetchFn(url)
  // redirect:'manual' (prod) → a 3xx redirect surfaces as ok:false here, so we NEVER follow a portal's
  // redirect off-host (SSRF); any non-200 / bodyless response → skip (best-effort).
  if (!res.ok || res.status !== 200 || !res.body) return null
  // Stream with an EARLY byte cap: never buffer an unbounded body. A portal that under-reports/omits
  // SIZE and streams a huge (or slow) body is aborted as soon as the running total crosses the cap
  // (breaking the for-await cancels the underlying stream).
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of res.body) {
    total += chunk.byteLength
    if (total > maxBytes) return null
    chunks.push(chunk)
  }
  if (total === 0) return null
  const name = typeof info?.NAME === 'string' && info.NAME ? info.NAME : `file-${fileId}`
  return { name, base64: Buffer.concat(chunks).toString('base64'), size: total }
}
