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
// Defaults chosen so the throttle path is ACTUALLY entered: Scenario A fires OPS*3 reads on one
// bucket, so OPS>=17 exhausts the 50-token burst and forces the 2/s drain (the gate asserts it did).
const JOBS = arg('--jobs', 6) // parallel "documents"/jobs → each gets its OWN limiter (scale-out)
const OPS = arg('--ops', 20) // REST calls per job (a crm-sync job does ~6-10 reads per op)

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
    // The QUERY_LIMIT_EXCEEDED token lives in AjaxError.code (the SDK keys on it); the .message is
    // human text — so capture BOTH `code` and String(e) or the escaped-QLE gate would never match.
    return hook.actions.v2.call.make({ method, params })
      .then(() => ({ ok: true }))
      .catch(e => ({ ok: false, code: String(e?.code ?? ''), msg: `${e?.code ?? ''} ${String(e)}` }))
  })
  return Promise.all(calls)
}

function qle(results) {
  return results.flat().filter(r => !r.ok && /QUERY_LIMIT_EXCEEDED/i.test(`${r.code} ${r.msg}`)).length
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
  const nA = OPS * 3
  const statsA = stats(hookA)
  console.log(`Scenario A — single limiter, ${nA} reads (OPS×3):`)
  console.log(`  ${ms(tookA)}  ~${(nA / (tookA / 1000)).toFixed(1)} req/s  ·  QUERY_LIMIT_EXCEEDED=${qle(resA)}  ·  limitHits=${statsA.limitHits}`)
  console.log(`  stats:`, JSON.stringify(statsA))

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

  // The gate is only meaningful if the throttle path was actually ENTERED (Scenario A burst
  // exhausted → limitHits>0). Otherwise "0 QLE" proves nothing (nothing was throttled).
  const engaged = statsA.limitHits > 0
  const pass = engaged && totalQle === 0
  console.log(`\n${pass ? '✅ DoD MET' : '❌ DoD NOT MET'}:`)
  console.log(`   • throttle engaged (Scenario A limitHits=${statsA.limitHits} > 0): ${engaged ? 'yes' : 'NO — raise --ops so OPS×3 > 50 burst'}`)
  console.log(`   • escaped QUERY_LIMIT_EXCEEDED under ${JOBS}× scale-out: ${totalQle} (want 0)`)
  console.log(`   Interpretation: the per-instance limiter self-throttles once its burst is spent, and`)
  console.log(`   default params (drainRate 2 / burst 50) let ${JOBS} concurrent limiters run without a`)
  console.log(`   single escaped QLE. NOTE: this exercises the rate-limit/burst dimension, NOT the`)
  console.log(`   sustained 10-min operating-limit (which needs heavy methods over minutes) — re-run`)
  console.log(`   with higher --jobs/--ops (or on tariff change) and keep both checks green.\n`)
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('\n❌ load-test FAILED:', e?.message ?? e, '\n')
  process.exit(1)
})
