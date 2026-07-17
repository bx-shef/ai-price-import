// Live load test + limiter calibration for #123 (dev-only, not part of SSG). Exercises the
// @bitrix24/b24jssdk RestrictionManager the crm-sync transport relies on, against a REAL portal
// via a git-ignored webhook (.env.b24test B24_TEST_WEBHOOK) — the limiter is the same class on
// the hook and the OAuth transport, so calibrating it here is representative.
//
//   pnpm loadtest:123                # default scenario (single limiter + scale-out sim)
//   pnpm loadtest:123 --jobs 4 --ops 12
//
// Measures: effective req/s, RestrictionManager getStats() (limitHits/retries/adaptiveDelays),
// and — the DoD gate — whether any QUERY_LIMIT_EXCEEDED slips through. Reads only (idempotent);
// no writes to the live portal.
import { readFileSync } from 'node:fs'
import { B24Hook } from '@bitrix24/b24jssdk'

const hookUrl = (() => {
  const m = readFileSync('.env.b24test', 'utf8').match(/^\s*B24_TEST_WEBHOOK=(.+)$/m)
  if (!m) throw new Error('B24_TEST_WEBHOOK not set in .env.b24test')
  return m[1].trim().replace(/^["']|["']$/g, '')
})()

const arg = (name, def) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def
}
const JOBS = arg('--jobs', 4) // parallel "documents"/jobs → each gets its OWN limiter (scale-out)
const OPS = arg('--ops', 10) // REST calls per job (a crm-sync job does ~6-10 reads per op)

// The reads a crm-sync job actually issues (company/product/VAT/units lookups). All idempotent.
const READS = [
  ['crm.item.list', { entityTypeId: 2, select: ['id', 'title'], start: 0 }],
  ['crm.vat.list', {}],
  ['crm.requisite.list', { select: ['ID', 'RQ_INN'], start: 0 }],
  ['catalog.measure.list', { select: ['code', 'measureTitle'] }],
  ['crm.currency.list', {}]
]

const ms = t => `${t.toFixed(0)}ms`
async function timed(fn) {
  const t0 = performance.now()
  const r = await fn()
  return [r, performance.now() - t0]
}

/** Aggregate the two per-http-client RestrictionManagers' stats on a hook. */
function stats(hook) {
  const a = hook._httpV2?.getStats?.() ?? {}
  const b = hook._httpV3?.getStats?.() ?? {}
  const sum = k => (a[k] ?? 0) + (b[k] ?? 0)
  return {
    totalRequests: sum('totalRequests'), successful: sum('successfulRequests'), failed: sum('failedRequests'),
    limitHits: sum('limitHits'), retries: sum('retries'), adaptiveDelays: sum('adaptiveDelays'),
    heavyRequestCount: sum('heavyRequestCount'), consecutiveErrors: Math.max(a.consecutiveErrors ?? 0, b.consecutiveErrors ?? 0)
  }
}

/** Run OPS mixed reads on one hook, concurrently; collect outcomes. */
async function runJob(hook) {
  const calls = Array.from({ length: OPS }, (_, i) => {
    const [method, params] = READS[i % READS.length]
    // Same call path production crm-sync uses (b24Sdk.makeSdkRestCall → actions.v2.call.make).
    return hook.actions.v2.call.make({ method, params }).then(() => ({ ok: true })).catch(e => ({ ok: false, msg: String(e?.message ?? e) }))
  })
  return Promise.all(calls)
}

function qle(results) {
  return results.flat().filter(r => !r.ok && /QUERY_LIMIT_EXCEEDED/i.test(r.msg || '')).length
}

async function main() {
  const host = new URL(hookUrl).host
  console.log(`\n▶ load-test #123 against ${host} · JOBS=${JOBS} OPS=${OPS} (default params: drainRate 2, burst 50)\n`)

  // --- Scenario A: ONE limiter (a single job doing OPS×3 reads back-to-back) ---
  const hookA = B24Hook.fromWebhookUrl(hookUrl)
  const [resA, tookA] = await timed(async () => {
    const rounds = await Promise.all(Array.from({ length: 3 }, () => runJob(hookA)))
    return rounds
  })
  const nA = JOBS * 0 + OPS * 3
  console.log(`Scenario A — single limiter, ${nA} reads:`)
  console.log(`  ${ms(tookA)}  ~${(nA / (tookA / 1000)).toFixed(1)} req/s  ·  QUERY_LIMIT_EXCEEDED=${qle(resA)}`)
  console.log(`  stats:`, JSON.stringify(stats(hookA)))

  // --- Scenario B: SCALE-OUT — JOBS separate hooks (each its own limiter), all firing at once ---
  // Mirrors N throughput workers on N B24OAuth instances hitting one portal in parallel.
  const hooks = Array.from({ length: JOBS }, () => B24Hook.fromWebhookUrl(hookUrl))
  const [resB, tookB] = await timed(() => Promise.all(hooks.map(runJob)))
  const nB = JOBS * OPS
  const totalQle = qle(resB)
  console.log(`\nScenario B — scale-out (${JOBS} concurrent limiters), ${nB} reads:`)
  console.log(`  ${ms(tookB)}  ~${(nB / (tookB / 1000)).toFixed(1)} req/s aggregate  ·  QUERY_LIMIT_EXCEEDED=${totalQle}`)
  const agg = hooks.map(stats).reduce((s, x) => ({ limitHits: s.limitHits + x.limitHits, retries: s.retries + x.retries, adaptiveDelays: s.adaptiveDelays + x.adaptiveDelays, failed: s.failed + x.failed }), { limitHits: 0, retries: 0, adaptiveDelays: 0, failed: 0 })
  console.log(`  aggregate stats:`, JSON.stringify(agg))

  console.log(`\n${totalQle === 0 ? '✅ DoD MET' : '❌ DoD FAILED'}: ${totalQle} QUERY_LIMIT_EXCEEDED under ${JOBS}× scale-out.`)
  console.log(`   Default RestrictionParams (drainRate 2 / burst 50) ${totalQle === 0 ? 'hold' : 'need lowering'} at this concurrency.`)
  console.log(`   Recommended prod cap: keep QUEUE_CRM_CONCURRENCY such that jobs×drainRate stays within the portal's ~2 req/s standard budget (operating-limit adaptivity smooths the rest).\n`)
}

main().catch((e) => {
  console.error('\n❌ load-test FAILED:', e?.message ?? e, '\n')
  process.exit(1)
})
