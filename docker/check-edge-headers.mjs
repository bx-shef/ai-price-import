// Build-time guard for the no-nginx target (#185 п.1), run from the Dockerfile against the freshly
// built server. It exists because the defect it catches is invisible to unit tests: Nitro serves a
// prerendered page from the public-assets handler, which runs BEFORE server/middleware, so headers
// attached there never reached any HTML — `/app` went out with no CSP (no frame-ancestors, i.e. no
// clickjacking protection) while `/api/health` carried the full set.
//
// Both paths are checked on purpose: one static, one dynamic. The original bug passed the dynamic
// half and failed the static one, so a probe of either alone would have missed it.
const BASE = `http://127.0.0.1:${process.env.NITRO_PORT || 3999}`

const fail = (msg) => {
  console.error(`BUILD FAILED: ${msg}`)
  process.exit(1)
}

// The server is starting in parallel — poll rather than sleep a fixed amount.
async function waitForBoot() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) return
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500))
  }
  fail('the built server did not answer /api/health within 30s — the header guard could not run')
}

await waitForBoot()

for (const path of ['/app', '/api/health']) {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(5000) })
  const csp = res.headers.get('content-security-policy')
  if (!csp) fail(`APP_EDGE_SECURITY=1 serves ${path} without a CSP header — security headers do not reach it`)
  if (path === '/app' && !csp.includes('frame-ancestors')) {
    fail('the CSP on /app carries no frame-ancestors — clickjacking protection is absent')
  }
}
console.log('edge security headers: ok (/app and /api/health both carry CSP)')
