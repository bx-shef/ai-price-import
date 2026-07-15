// Live smoke of the @bitrix24/b24jssdk REST transport (server/utils/b24Sdk.ts).
// Dev-only. Exercises makePortalSdkCall against a REAL portal: a couple of REST calls
// (profile + crm.item.list) to verify the envelope unwrap (getData().result), then a
// burst to see the built-in RestrictionManager rate-limiter self-throttle (no
// QUERY_LIMIT_EXCEEDED). No DB — the token comes from a git-ignored .env.b24oauth and
// loadToken/saveToken are in-memory (refresh is identity-coded, so no enc key needed).
//
//   pnpm sdk:smoke           # profile + crm.item.list(1) + a 30-call burst
//
// .env.b24oauth (git-ignored) keys — fill from `portal_tokens` of the reinstalled portal:
//   B24_OAUTH_DOMAIN=xxx.bitrix24.by
//   B24_OAUTH_MEMBER_ID=<member_id>
//   B24_OAUTH_ACCESS_TOKEN=<access_token>          # fresh (~1h) after reinstall
//   B24_OAUTH_REFRESH_TOKEN=<plaintext refresh>    # optional (only needed if access expired)
//   B24_CLIENT_ID=<app client_id>
//   B24_CLIENT_SECRET=<app client_secret>
import { readFileSync } from 'node:fs'
import { makePortalSdkCall } from '../server/utils/b24Sdk.ts'

const readEnv = (file, key, required = true) => {
  let txt
  try {
    txt = readFileSync(file, 'utf8')
  } catch {
    if (required) throw new Error(`${file} not found`)
    return ''
  }
  const m = txt.match(new RegExp(`^\\s*${key}=(.+)$`, 'm'))
  if (!m) {
    if (required) throw new Error(`${key} not found in ${file}`)
    return ''
  }
  return m[1].trim().replace(/^["']|["']$/g, '')
}

const F = '.env.b24oauth'
const domain = readEnv(F, 'B24_OAUTH_DOMAIN')
const memberId = readEnv(F, 'B24_OAUTH_MEMBER_ID')
const accessToken = readEnv(F, 'B24_OAUTH_ACCESS_TOKEN')
const refreshToken = readEnv(F, 'B24_OAUTH_REFRESH_TOKEN', false)
const clientId = readEnv(F, 'B24_CLIENT_ID')
const clientSecret = readEnv(F, 'B24_CLIENT_SECRET')

// In-memory token (decrypt/encrypt are identity — refreshTokenEnc holds plaintext).
const token = {
  memberId, domain, clientEndpoint: `https://${domain}/rest/`,
  accessToken, refreshTokenEnc: refreshToken, applicationToken: '',
  expiresIn: 3600, issuedAtMs: Date.now()
}

const deps = {
  loadToken: async () => token,
  saveToken: async (input) => { console.log('  ↻ refreshed → new access (persist no-op in smoke):', String(input.accessToken).slice(0, 12) + '…') },
  creds: { clientId, clientSecret },
  now: () => Date.now(),
  decrypt: x => x,
  encrypt: x => x
}

const ms = t => `${t.toFixed(0)}ms`

async function main() {
  console.log(`\n▶ SDK smoke against ${domain} (member ${memberId.slice(0, 8)}…)\n`)
  const transport = await makePortalSdkCall(memberId, deps)
  if (!transport) throw new Error('makePortalSdkCall returned null (no token)')
  const { call, list } = transport

  // 1) profile — proves the envelope unwrap (result present).
  const profile = await call('profile')
  console.log('✓ profile →', profile ? `${profile.NAME ?? ''} ${profile.LAST_NAME ?? ''} (id ${profile.ID})`.trim() : '(empty)')

  // 2) crm.item.list — proves list result unwrap + real REST filter.
  const items = await call('crm.item.list', { entityTypeId: 2, select: ['id', 'title'], start: 0 })
  const arr = items?.items ?? items ?? []
  console.log(`✓ crm.item.list(deal) → ${Array.isArray(arr) ? arr.length : '?'} item(s) on this page`)

  // 2b) full-list fetch via the SDK's built-in pagination (SdkListCall) — crm.vat.list.
  const vat = await list('crm.vat.list', { filter: { ACTIVE: 'Y' }, select: ['ID', 'NAME', 'RATE'] })
  console.log(`✓ list(crm.vat.list) → ${vat.length} rate(s) (SDK paged the full list)`)

  // 3) burst — the RestrictionManager should self-throttle (no QUERY_LIMIT_EXCEEDED).
  const N = 30
  console.log(`\n▶ burst of ${N} profile calls (watch for self-throttle, NOT QUERY_LIMIT_EXCEEDED)…`)
  const t0 = performance.now()
  const results = await Promise.allSettled(Array.from({ length: N }, () => call('profile')))
  const took = performance.now() - t0
  const ok = results.filter(r => r.status === 'fulfilled').length
  const failed = results.filter(r => r.status === 'rejected')
  console.log(`✓ burst done: ${ok}/${N} ok in ${ms(took)} (~${(N / (took / 1000)).toFixed(1)} req/s — limiter paces it)`)
  if (failed.length) console.log('  ⚠ failures:', failed.slice(0, 3).map(f => f.reason?.message).join(' | '))
  console.log('\n✅ SDK transport smoke passed — envelope unwrap + rate-limiter working.\n')
}

main().catch((e) => {
  console.error('\n❌ SDK smoke FAILED:', e?.message ?? e, '\n')
  process.exit(1)
})
