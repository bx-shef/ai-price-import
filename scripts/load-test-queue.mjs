// Load test for the IMPORT QUEUE itself (dev-only, not part of SSG).
//
// GOAL (owner): under a mass upload the app must NOT refuse work and must NOT lose documents — it
// holds the queue and grinds through it. Slow-but-everything-arrived is a PASS; a refused, lost or
// duplicated document is a FAIL.
//
//   pnpm loadtest:queue                       # default: 120 jobs across 6 portals, 3 workers
//   pnpm loadtest:queue --jobs 300 --workers 4 --concurrency 4
//
// Runs against a LOCAL Redis (REDIS_URL, default redis://127.0.0.1:6379) with the REAL BullMQ
// Queue/Worker classes and the REAL crm-sync lock tuning, but a STUB handler: this measures the
// QUEUE's behaviour (backlog drain, exactly-once, stalled recovery, concurrency cap, scale-out),
// which is portal-independent. Live-portal throughput is the separate `pnpm loadtest:123`
// (RestrictionManager) and the E2E `pnpm live:crm --ai`.
//
// Every scenario writes to its own queue name (suffixed with the run id) and removes it at the end,
// so a run never collides with a real dev queue or with a parallel run.
import { Queue, Worker } from 'bullmq'

const arg = (name, def) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def
}
const JOBS = arg('--jobs', 120)
const PORTALS = arg('--portals', 6)
const WORKERS = arg('--workers', 3)
const CONCURRENCY = arg('--concurrency', 4)
const WORK_MS = arg('--work-ms', 12) // simulated per-document processing time

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379'
const connection = (() => {
  const u = new URL(REDIS_URL)
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: u.password } : {}),
    maxRetriesPerRequest: null
  }
})()

// Mirrors server/queue/worker.ts crmLockTuning() — the whole point of the stalled-recovery scenario
// is to exercise the SAME lock settings production uses.
const CRM_LOCK = { lockDuration: 60_000, stalledInterval: 60_000, maxStalledCount: 1 }

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
const ok = m => console.log(`${C.g}  ✓${C.x} ${m}`)
const bad = m => console.log(`${C.r}  ✗${C.x} ${m}`)
const info = m => console.log(`${C.d}    ${m}${C.x}`)
const head = m => console.log(`\n${C.b}${m}${C.x}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const failures = []
const check = (cond, msg) => (cond ? ok(msg) : (failures.push(msg), bad(msg)))

const runId = `lt${Date.now().toString(36)}`
const qname = s => `loadtest-${s}-${runId}`
const created = []
async function makeQueue(suffix) {
  const q = new Queue(qname(suffix), { connection })
  created.push(q)
  return q
}
/** Deterministic job id per (portal, doc) — the same shape crm-sync uses so a retry dedupes. */
const jobIdFor = (portal, n) => `cs|${portal}|doc${n}`

// ---------------------------------------------------------------------------------------------
// 1. Backlog: a mass upload from many portals at once must fully drain, exactly once per document.
// ---------------------------------------------------------------------------------------------
async function scenarioBacklog() {
  head(`1 · Массовая загрузка: ${JOBS} документов от ${PORTALS} порталов, ${WORKERS} воркеров × ${CONCURRENCY}`)
  const q = await makeQueue('backlog')

  const payloads = Array.from({ length: JOBS }, (_, i) => ({
    memberId: `portal${i % PORTALS}`,
    jobId: `doc${i}`,
    n: i
  }))
  await q.addBulk(payloads.map(p => ({
    name: 'crm-sync',
    data: p,
    opts: { jobId: jobIdFor(p.memberId, p.n), removeOnComplete: false, removeOnFail: false }
  })))

  const waitingAtStart = await q.getWaitingCount()
  info(`очередь после постановки: ${waitingAtStart} задач ожидают`)

  const processed = []
  let inFlight = 0
  let peakInFlight = 0
  const samples = []
  const started = Date.now()

  const workers = Array.from({ length: WORKERS }, () => new Worker(q.name, async (job) => {
    inFlight++
    peakInFlight = Math.max(peakInFlight, inFlight)
    try {
      await sleep(WORK_MS)
      processed.push(job.data.jobId)
      return { ok: true }
    } finally {
      inFlight--
    }
  }, { connection, concurrency: CONCURRENCY, ...CRM_LOCK }))

  // Watch the backlog drain instead of just waiting for the end — «держит очередь» is the claim.
  while (processed.length < JOBS && Date.now() - started < 120_000) {
    samples.push(await q.getWaitingCount() + await q.getActiveCount())
    await sleep(120)
  }
  const elapsed = Date.now() - started
  await Promise.all(workers.map(w => w.close()))

  const unique = new Set(processed)
  check(processed.length === JOBS, `обработаны ВСЕ ${JOBS} документов (получено ${processed.length}) — ничего не потеряно`)
  check(unique.size === JOBS, `каждый документ обработан РОВНО один раз (уникальных ${unique.size}) — дублей нет`)
  const left = await q.getWaitingCount() + await q.getActiveCount()
  check(left === 0, `очередь разгрузилась до нуля (осталось ${left})`)
  const cap = WORKERS * CONCURRENCY
  check(peakInFlight <= cap, `одновременно в работе не больше лимита: пик ${peakInFlight} ≤ ${cap}`)

  const peakBacklog = Math.max(...samples, waitingAtStart)
  const rate = (JOBS / (elapsed / 1000)).toFixed(1)
  info(`пик очереди ${peakBacklog} → 0; время разгрузки ${(elapsed / 1000).toFixed(1)} с; пропускная способность ${rate} док/с`)
  info(`профиль очереди: ${samples.filter((_, i) => i % Math.max(1, Math.ceil(samples.length / 8)) === 0).join(' → ')} → 0`)
  return { rate, elapsed, peakBacklog }
}

// ---------------------------------------------------------------------------------------------
// 2. Идемпотентность: повторная постановка того же документа не создаёт вторую задачу.
// ---------------------------------------------------------------------------------------------
async function scenarioIdempotency() {
  head('2 · Повторная отправка того же документа')
  const q = await makeQueue('idem')
  const seen = []
  const worker = new Worker(q.name, async (job) => {
    seen.push(job.id)
    await sleep(5)
  }, { connection, concurrency: 2, ...CRM_LOCK })

  const id = jobIdFor('portalX', 42)
  const data = { memberId: 'portalX', jobId: 'doc42' }
  const a = await q.add('crm-sync', data, { jobId: id })
  const b = await q.add('crm-sync', data, { jobId: id }) // ретрай/двойной клик
  const c = await q.add('crm-sync', data, { jobId: id })
  check(a.id === b.id && b.id === c.id, 'три постановки одного документа дали ОДНУ задачу (дедуп по jobId)')

  await sleep(400)
  await worker.close()
  check(seen.length === 1, `обработчик вызван один раз (вызовов ${seen.length}) — сущность в CRM не задвоится`)
}

// ---------------------------------------------------------------------------------------------
// 3. Падение воркера в середине пачки: задача переезжает и завершается, ничего не теряется.
// ---------------------------------------------------------------------------------------------
async function scenarioWorkerCrash() {
  head('3 · Воркер падает в середине пачки')
  const q = await makeQueue('crash')
  const N = 20
  await q.addBulk(Array.from({ length: N }, (_, i) => ({
    name: 'crm-sync',
    data: { memberId: 'portalC', jobId: `doc${i}` },
    opts: { jobId: jobIdFor('portalC', i) }
  })))

  // ACCELERATED lock: production uses lockDuration/stalledInterval = 60 s (crmLockTuning) so a live,
  // slow job is never falsely declared dead. Waiting 60 s here would make the test useless, so this
  // scenario runs the SAME mechanism with a 2 s lock — what we verify is the RECOVERY PATH, not the
  // timeout value. maxStalledCount:1 is kept exactly as production.
  const FAST_LOCK = { lockDuration: 2_000, stalledInterval: 2_000, maxStalledCount: 1 }
  const handledCount = new Map() // jobId → сколько раз обработчик его брал
  const mkWorker = () => new Worker(q.name, async (job) => {
    await sleep(15)
    handledCount.set(job.data.jobId, (handledCount.get(job.data.jobId) ?? 0) + 1)
  }, { connection, concurrency: 2, ...FAST_LOCK })

  const w1 = mkWorker()
  await sleep(120) // дать поработать
  const midway = handledCount.size
  await w1.close(true) // ЖЁСТКО обрываем — как упавший контейнер
  const stuck = await q.getActiveCount()
  info(`воркер оборван, успев взять ${midway} из ${N}; зависло в состоянии «в работе»: ${stuck}`)
  check(midway < N, 'обрыв действительно случился в середине пачки (сценарий не выродился)')

  const w2 = mkWorker() // на замену поднимается новая реплика
  const until = Date.now() + 30_000
  while (Date.now() < until) {
    const left = await q.getWaitingCount() + await q.getActiveCount()
    if (handledCount.size >= N && left === 0) break
    await sleep(100)
  }
  await w2.close()

  check(handledCount.size === N, `после подъёма замены обработаны все ${N} документов (получено ${handledCount.size}) — потерь нет`)
  const left = await q.getWaitingCount() + await q.getActiveCount()
  check(left === 0, `очередь полностью разгрузилась после восстановления (осталось ${left})`)

  // ВАЖНО: зависшая задача возвращается в работу и обработчик берёт её ПОВТОРНО. Очередь даёт
  // «хотя бы один раз», а не «ровно один раз» — от задвоения сущности в CRM защищает не очередь,
  // а маркер идемпотентности (поиск перед созданием в crm-sync).
  const redelivered = [...handledCount.entries()].filter(([, n]) => n > 1)
  if (redelivered.length) {
    info(`повторно доставлено после обрыва: ${redelivered.length} шт. (${redelivered.map(([k]) => k).join(', ')})`)
    info('это ожидаемо: очередь гарантирует «хотя бы один раз»; дубль в CRM ловит маркер идемпотентности')
  } else {
    info('повторных доставок не потребовалось (все задачи успели зафиксироваться до обрыва)')
  }
}

// ---------------------------------------------------------------------------------------------
// 4. Scale-out: несколько реплик тянут из ОДНОЙ очереди, задача достаётся ровно одной.
// ---------------------------------------------------------------------------------------------
async function scenarioScaleOut() {
  head('4 · Несколько реплик воркера на одной очереди')
  const q = await makeQueue('scale')
  const N = 60
  await q.addBulk(Array.from({ length: N }, (_, i) => ({
    name: 'crm-sync',
    data: { memberId: `portal${i % 3}`, jobId: `doc${i}` },
    opts: { jobId: jobIdFor('scaleP', i) }
  })))

  const byWorker = [0, 0, 0]
  const handled = []
  const workers = byWorker.map((_, idx) => new Worker(q.name, async (job) => {
    byWorker[idx]++
    handled.push(job.data.jobId)
    await sleep(8)
  }, { connection, concurrency: 3, ...CRM_LOCK }))

  const until = Date.now() + 20_000
  while (handled.length < N && Date.now() < until) await sleep(60)
  await Promise.all(workers.map(w => w.close()))

  check(handled.length === N, `все ${N} задач разобраны (получено ${handled.length})`)
  check(new Set(handled).size === N, 'ни одна задача не досталась двум репликам сразу')
  check(byWorker.every(c => c > 0), `нагрузка легла на все реплики: ${byWorker.join(' / ')}`)
}

// ---------------------------------------------------------------------------------------------
// 5. Приём под нагрузкой: постановка в очередь остаётся быстрой, пока воркеры разгребают backlog.
//    Это и есть «не отказывать»: пользователь загружает документ и получает подтверждение сразу.
// ---------------------------------------------------------------------------------------------
async function scenarioAcceptUnderLoad() {
  head('5 · Приём новых документов, пока очередь ещё разгребается')
  const q = await makeQueue('accept')
  await q.addBulk(Array.from({ length: 200 }, (_, i) => ({
    name: 'crm-sync',
    data: { memberId: 'portalL', jobId: `bulk${i}` },
    opts: { jobId: jobIdFor('portalL', i) }
  })))

  const worker = new Worker(q.name, async () => {
    await sleep(20)
  },
  { connection, concurrency: 2, ...CRM_LOCK })

  // Ставим 20 «пользовательских» задач поверх большого backlog и меряем задержку приёма.
  const lat = []
  for (let i = 0; i < 20; i++) {
    const t = Date.now()
    await q.add('crm-sync', { memberId: 'portalL', jobId: `user${i}` }, { jobId: `cs|portalL|user${i}` })
    lat.push(Date.now() - t)
    await sleep(10)
  }
  await worker.close()
  await q.obliterate({ force: true }).catch(() => {})

  const sorted = [...lat].sort((a, b) => a - b)
  const p95 = sorted[Math.floor(sorted.length * 0.95)]
  const max = sorted[sorted.length - 1]
  check(p95 < 250, `приём документа под нагрузкой быстрый: p95 ${p95} мс, худший ${max} мс (приложение не отказывает)`)
  info(`задержки постановки: медиана ${sorted[Math.floor(sorted.length / 2)]} мс, p95 ${p95} мс, max ${max} мс`)
}

// ---------------------------------------------------------------------------------------------
async function main() {
  console.log(`${C.b}Нагрузочное тестирование очереди импорта${C.x}`)
  console.log(`${C.d}Redis: ${REDIS_URL} · прогон ${runId}${C.x}`)
  console.log(`${C.d}Цель: не отказывать и не терять документы — держать очередь и всё постепенно обработать.${C.x}`)

  const summary = await scenarioBacklog()
  await scenarioIdempotency()
  await scenarioWorkerCrash()
  await scenarioScaleOut()
  await scenarioAcceptUnderLoad()

  head('Итог')
  info(`пропускная способность ${summary.rate} док/с · пик очереди ${summary.peakBacklog} · разгрузка ${(summary.elapsed / 1000).toFixed(1)} с`)
  if (failures.length) {
    console.log(`\n${C.r}ПРОВАЛ: ${failures.length}${C.x}`)
    failures.forEach(f => console.log(`  - ${f}`))
  } else {
    console.log(`\n${C.g}Все проверки пройдены — очередь держит нагрузку и разгружается полностью.${C.x}`)
  }

  for (const q of created) {
    await q.obliterate({ force: true }).catch(() => {})
    await q.close().catch(() => {})
  }
  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => {
  console.error(`${C.r}Прогон упал:${C.x}`, e?.message ?? e)
  process.exit(1)
})
