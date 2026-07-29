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
const redisUrl = new URL(REDIS_URL)

// SAFETY GATE. This script writes thousands of keys and calls queue.obliterate(). REDIS_URL is
// commonly inherited from a shell that still holds production values, so refuse to run against
// anything but a local Redis unless the operator opts in EXPLICITLY. Queue names are suffixed with
// a run id and can never collide with the real b24-events/file-extract/agent-run/crm-sync queues,
// but that is one barrier — this is the second, and it fails CLOSED.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', 'redis'])
if (!LOCAL_HOSTS.has(redisUrl.hostname) && !process.argv.includes('--allow-remote-redis')) {
  console.error(`Отказ: REDIS_URL указывает на «${redisUrl.hostname}», а не на локальный Redis.`)
  console.error('Скрипт создаёт тысячи задач и удаляет свои очереди — на боевом Redis это лишняя нагрузка и мусор.')
  // `--dir /tmp` matters: started from the repo root, Redis drops its dump.rdb right here.
  console.error('Поднимите локальный Redis (redis-server --daemonize yes --dir /tmp) или, если вы точно уверены,')
  console.error('запустите с флагом --allow-remote-redis.')
  process.exit(1)
}

const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.username ? { username: redisUrl.username } : {}),
  ...(redisUrl.password ? { password: redisUrl.password } : {}),
  ...(redisUrl.protocol === 'rediss:' ? { tls: {} } : {}),
  ...(redisUrl.pathname.length > 1 ? { db: Number(redisUrl.pathname.slice(1)) || 0 } : {}),
  maxRetriesPerRequest: null
}
/** Never print REDIS_URL raw — it may carry a password. */
const SAFE_REDIS = `${redisUrl.protocol}//${redisUrl.host}${redisUrl.pathname}`

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
/** Drop ONLY the temporary queues this run created. The name assert is defence-in-depth: a future
 *  scenario that forgets the `qname()` helper must never be able to obliterate a real queue. */
async function cleanup() {
  for (const q of created) {
    if (!q.name.startsWith('loadtest-')) {
      console.error(`ОТКАЗ чистить очередь «${q.name}» — имя не похоже на временную очередь прогона`)
      continue
    }
    await q.obliterate({ force: true }).catch(() => {})
    await q.close().catch(() => {})
  }
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
  let peakActiveInRedis = 0
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
    const active = await q.getActiveCount()
    peakActiveInRedis = Math.max(peakActiveInRedis, active)
    samples.push(await q.getWaitingCount() + active)
    await sleep(120)
  }
  const elapsed = Date.now() - started
  await Promise.all(workers.map(w => w.close()))

  const unique = new Set(processed)
  check(processed.length === JOBS, `обработаны ВСЕ ${JOBS} документов (получено ${processed.length}) — ничего не потеряно`)
  check(unique.size === JOBS, `каждый документ обработан РОВНО один раз (уникальных ${unique.size}) — дублей нет`)
  // Cross-check against REDIS, not just the in-process counter: a handler that ran but whose
  // completion never committed would satisfy the array and still be a lost document.
  const completedInRedis = await q.getCompletedCount()
  const failedInRedis = await q.getFailedCount()
  check(completedInRedis === JOBS, `Redis подтверждает завершение всех ${JOBS} задач (completed=${completedInRedis})`)
  check(failedInRedis === 0, `упавших задач нет (failed=${failedInRedis})`)
  const left = await q.getWaitingCount() + await q.getActiveCount()
  check(left === 0, `очередь разгрузилась до нуля (осталось ${left})`)
  const cap = WORKERS * CONCURRENCY
  // Two independent views of the parallelism cap: the in-process counter (what our handler saw) and
  // what REDIS reported as active while draining — the local counter alone is close to a tautology,
  // BullMQ cannot call the handler more than `concurrency` times in one process by construction.
  check(peakInFlight <= cap, `одновременно в работе не больше лимита: пик ${peakInFlight} ≤ ${cap} (счётчик обработчика)`)
  check(peakActiveInRedis <= cap, `Redis тоже не видел больше ${cap} активных задач (пик ${peakActiveInRedis})`)

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

  // Wait for the job to actually COMPLETE instead of sleeping a guessed interval — a fixed sleep
  // turns into a flake the moment the machine is busy.
  const until = Date.now() + 10_000
  while (Date.now() < until && (await q.getCompletedCount()) < 1) await sleep(25)
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
  // ASSERT, not log: without this the scenario would stay green even if stalled-recovery were
  // broken outright — «все дошли» can also mean «ничего и не зависало», i.e. the path never ran.
  check(stuck > 0, `после обрыва действительно зависли задачи в состоянии «в работе» (${stuck}) — было что восстанавливать`)
  check(redelivered.length > 0, `зависшие задачи ПЕРЕДОСТАВЛЕНЫ новой реплике (${redelivered.length} шт.) — механизм восстановления сработал`)
  info(`повторно доставлено: ${redelivered.map(([k]) => k).join(', ')}`)
  info('это ожидаемо: очередь гарантирует «хотя бы один раз»; дубль в CRM ловит маркер идемпотентности')
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
  check(await q.getCompletedCount() === N, 'Redis подтверждает завершение всех задач')
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
// 6. РЕАЛИСТИЧНЫЙ ТЕМП. Сценарии 1-5 меряют саму очередь, и её потолок (сотни док/с) к реальности
//    отношения не имеет: настоящее узкое место — лимитер Битрикс24 (~2 запроса/с на портал), а один
//    документ стоит ~8 REST-вызовов, то есть ~4 с на документ на портал. Здесь обработчик работает
//    именно в этом темпе — чтобы ответить на вопрос владельца «держит ли очередь», а не «сколько
//    задач в секунду прожуёт Redis». Пропускается флагом --skip-slow.
// ---------------------------------------------------------------------------------------------
const PORTAL_RPS = 2 // leaky-bucket лимитера Б24 на портал
const REST_PER_DOC = 8 // сколько REST-вызовов делает crm-sync на один документ (оценка)
const SEC_PER_DOC = REST_PER_DOC / PORTAL_RPS // ≈ 4 с на документ на портал

async function scenarioRealisticPace() {
  head('6 · Реалистичный темп: обработка в ритме лимитера Битрикс24')
  if (process.argv.includes('--skip-slow')) {
    info('пропущено (--skip-slow)')
    return null
  }
  const q = await makeQueue('pace')
  const portals = 3
  const perPortal = 3
  const N = portals * perPortal
  info(`${REST_PER_DOC} REST-вызовов на документ при лимите ${PORTAL_RPS} зап/с ⇒ ${SEC_PER_DOC} с на документ на портал`)
  info(`${N} документов от ${portals} порталов — ожидаем ≈ ${(perPortal * SEC_PER_DOC).toFixed(0)} с`)

  await q.addBulk(Array.from({ length: N }, (_, i) => ({
    name: 'crm-sync',
    data: { memberId: `portal${i % portals}`, jobId: `doc${i}` },
    opts: { jobId: jobIdFor(`pace${i % portals}`, i) }
  })))

  // Один «бакет» на портал: документы одного портала идут строго по очереди в темпе лимитера,
  // разные порталы — параллельно. Так же ведёт себя прод: лимитер пер-портальный.
  const busyUntil = new Map()
  const done = []
  const worker = new Worker(q.name, async (job) => {
    const key = job.data.memberId
    const now = Date.now()
    const start = Math.max(now, busyUntil.get(key) ?? 0)
    busyUntil.set(key, start + SEC_PER_DOC * 1000)
    await sleep(start - now + SEC_PER_DOC * 1000)
    done.push(job.data.jobId)
  }, { connection, concurrency: portals * 2, ...CRM_LOCK })

  const started = Date.now()
  const until = started + 90_000
  while (done.length < N && Date.now() < until) await sleep(200)
  const elapsed = (Date.now() - started) / 1000
  await worker.close()

  check(done.length === N, `все ${N} документов обработаны в реальном темпе (получено ${done.length})`)
  const left = await q.getWaitingCount() + await q.getActiveCount()
  check(left === 0, `очередь разгрузилась (осталось ${left})`)
  // Очередь не должна быть узким местом: время близко к теоретическому минимуму, который
  // задаёт лимитер портала, а не накладные расходы BullMQ.
  const floor = perPortal * SEC_PER_DOC
  check(elapsed < floor * 1.6, `время разгрузки ${elapsed.toFixed(1)} с близко к пределу лимитера ${floor} с — тормозит портал, а не очередь`)

  const perHourPerPortal = Math.floor(3600 / SEC_PER_DOC)
  info(`РЕАЛЬНАЯ оценка: ≈ ${perHourPerPortal} документов в час НА ПОРТАЛ (упирается в лимитер Б24)`)
  info(`1000 документов одного портала разгребались бы ≈ ${(1000 * SEC_PER_DOC / 3600).toFixed(1)} ч — очередь их держит, но быстрее лимитер не даст`)
  return { perHourPerPortal }
}

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// 7. Ретраи: обработчик БРОСАЕТ. Проверяем обычный путь отказа — его не покрывал ни один сценарий.
//
// Почему это важно именно нам: crm-sync создаёт НЕидемпотентные сущности, in-SDK ретрай отключён,
// и вся защита от дублей построена на том, что повторяет ЦЕЛУЮ джобу очередь, а find-before-create
// ловит повтор по маркеру. То есть ретраи — несущая часть схемы, а проверены были только
// рассуждением. Сценарий №3 рядом проверяет ДРУГОЙ механизм — восстановление зависшей задачи после
// обрыва воркера; здесь же обработчик жив и честно бросает исключение.
// ---------------------------------------------------------------------------------------------
async function scenarioRetries() {
  head('7 · Обработчик падает: повторы, пауза между ними, список неудачных')
  const q = await makeQueue('retries')

  // Прод: attempts 3, backoff exponential 5000 (server/queue/connection.ts). Тип backoff сохраняем —
  // проверяем именно РОСТ пауз; сам delay ужимаем, иначе один прогон занял бы 35 секунд.
  const ATTEMPTS = 3
  const DELAY = 300
  const jobOpts = {
    attempts: ATTEMPTS,
    backoff: { type: 'exponential', delay: DELAY },
    removeOnComplete: false,
    removeOnFail: false
  }

  // Три вида задач в ОДНОЙ пачке — как в жизни: часть падает навсегда, часть переживает сбой,
  // часть проходит сразу.
  const ALWAYS = 3 // падают всегда → должны осесть в списке неудачных
  const FLAKY = 3 // падают дважды, на третьей попытке проходят → наш продовый случай (сбой Б24)
  const GOOD = 6 // не падают вовсе → не должны страдать от чужих ретраев
  const jobs = [
    ...Array.from({ length: ALWAYS }, (_, i) => ({ kind: 'always', n: i })),
    ...Array.from({ length: FLAKY }, (_, i) => ({ kind: 'flaky', n: i })),
    ...Array.from({ length: GOOD }, (_, i) => ({ kind: 'good', n: i }))
  ]
  await q.addBulk(jobs.map(j => ({
    name: 'crm-sync',
    data: { memberId: 'portalR', jobId: `${j.kind}${j.n}`, kind: j.kind },
    opts: { ...jobOpts, jobId: `cs|portalR|${j.kind}${j.n}` }
  })))

  const attemptsAt = new Map() // jobId → отметки времени каждой попытки
  const doneAt = new Map() // jobId → когда успешно завершилась
  const worker = new Worker(q.name, async (job) => {
    const id = job.data.jobId
    const seen = attemptsAt.get(id) ?? []
    seen.push(Date.now())
    attemptsAt.set(id, seen)
    if (job.data.kind === 'always') throw new Error('в CRM не записалось (подстроенный сбой)')
    if (job.data.kind === 'flaky' && seen.length < 3) throw new Error('связь с порталом оборвалась')
    doneAt.set(id, Date.now())
  }, { connection, concurrency: 4, ...CRM_LOCK })

  // Дедуп поверх ретраев: ставим ту же задачу, пока предыдущая ЖДЁТ следующей попытки. Ждём именно
  // появления отложенной задачи, а не «примерно столько же миллисекунд»: иначе на холодном Redis
  // дубль пришёлся бы на состояние «в очереди», и проверялся бы уже не тот путь.
  const untilDelayed = Date.now() + 5_000
  while (Date.now() < untilDelayed && (await q.getDelayedCount()) === 0) await sleep(20)
  const delayedBefore = await q.getDelayedCount()
  await q.add('crm-sync', { memberId: 'portalR', jobId: 'always0', kind: 'always' },
    { ...jobOpts, jobId: 'cs|portalR|always0' })

  // Выходим по ФАКТУ (сколько осело в неудачных и сколько дошло), а не по сумме waiting/active/
  // delayed: это три отдельных запроса, и задача, переехавшая из отложенных в очередь между первым
  // и третьим, не попадёт ни в один — сумма покажет ноль при живой задаче. Причём переезд
  // «отложена → в очереди» и есть механика повтора, то есть промах шёл бы в опасную сторону.
  const until = Date.now() + 30_000
  while (Date.now() < until) {
    if ((await q.getFailedCount()) >= ALWAYS && doneAt.size >= FLAKY + GOOD) break
    await sleep(50)
  }
  await worker.close()

  // 1. Повторов ровно столько, сколько задано, — не больше и не меньше.
  const alwaysTries = Array.from({ length: ALWAYS }, (_, i) => (attemptsAt.get(`always${i}`) ?? []).length)
  check(alwaysTries.every(n => n === ATTEMPTS),
    `падающая задача повторяется ровно ${ATTEMPTS} раза (получено: ${alwaysTries.join(', ')})`)

  // 2. Пауза между попытками РАСТЁТ — проверяем по факту, а не по конфигу.
  const gaps = (attemptsAt.get('always0') ?? []).slice(1).map((t, i) => t - attemptsAt.get('always0')[i])
  // Сравниваем РАЗНОСТЬ, а не отношение. Замеряются интервалы между входами в обработчик, поэтому
  // в каждый gap входят одинаковые накладные ε (промоушен, забор из очереди). В отношении
  // (2d+ε)/(d+ε) эти ε давят результат вниз и на медленной машине уронили бы проверку; в разности
  // они сокращаются. Просто «вторая больше первой» не годится: при фиксированном backoff это
  // проскакивает на шуме планировщика — проверено мутацией, слабую версию она не роняла.
  check(gaps.length >= 2 && gaps[1] - gaps[0] > DELAY * 0.5,
    `пауза между попытками растёт на ${gaps.length >= 2 ? gaps[1] - gaps[0] : '?'} мс (${gaps.map(g => `${g} мс`).join(' → ')}) — backoff экспоненциальный, а не фиксированный`)

  // 3. Перемежающийся отказ дорабатывает успешно — ровно то, что происходит при сбое связи с Б24.
  const flakyDone = Array.from({ length: FLAKY }, (_, i) => doneAt.has(`flaky${i}`)).filter(Boolean).length
  check(flakyDone === FLAKY,
    `задача, упавшая дважды, на повторе доходит до конца (${flakyDone} из ${FLAKY}) — сетевой сбой сам себя лечит`)

  // 4. Успешные соседи не страдают от чужих ретраев.
  const goodDone = Array.from({ length: GOOD }, (_, i) => doneAt.has(`good${i}`)).filter(Boolean).length
  check(goodDone === GOOD,
    `исправные задачи проходят, пока рядом кто-то ретраится (${goodDone} из ${GOOD}) — очередь не встала`)

  // 5. Список неудачных читается, и в нём именно те задачи и именно с причиной.
  const failed = await q.getFailed()
  check(failed.length === ALWAYS,
    `в списке неудачных ровно ${ALWAYS} задачи (найдено ${failed.length}) — исчерпавшие попытки не потерялись`)
  check(failed.every(j => /подстроенный сбой/.test(j.failedReason ?? '')),
    'у каждой неудачной задачи сохранена причина отказа — оператор увидит, что случилось')
  check(failed.every(j => j.attemptsMade === ATTEMPTS),
    `у неудачных задач зафиксировано по ${ATTEMPTS} попытки`)

  // 6. Дедуп поверх ретраев. Считаем РЕАЛЬНЫЕ задачи в очереди, а не разные ключи в нашей карте:
  // карта ключуется по jobId из payload, поэтому дубль писал бы попытки в ту же ячейку и проверка
  // «разных ключей 12» осталась бы зелёной при сломанном дедупе — она не измеряла ничего.
  const total = await q.getJobCounts()
  const EXPECTED = ALWAYS + FLAKY + GOOD
  check(delayedBefore > 0, 'дубль ставился, когда предыдущая попытка действительно ждала повтора')
  check(total.completed + total.failed === EXPECTED,
    `в очереди ровно ${EXPECTED} задач (готово ${total.completed} + неудачных ${total.failed}) — повторная постановка того же id дубля не создала`)
  info(`итог очереди: ${JSON.stringify(total)}`)
}

async function main() {
  console.log(`${C.b}Нагрузочное тестирование очереди импорта${C.x}`)
  console.log(`${C.d}Redis: ${SAFE_REDIS} · прогон ${runId}${C.x}`)
  console.log(`${C.d}Цель: не отказывать и не терять документы — держать очередь и всё постепенно обработать.${C.x}`)

  let summary
  let pace
  try {
    summary = await scenarioBacklog()
    await scenarioIdempotency()
    await scenarioWorkerCrash()
    await scenarioScaleOut()
    await scenarioAcceptUnderLoad()
    pace = await scenarioRealisticPace()
    await scenarioRetries()
  } finally {
    // Clean up even when a scenario throws — otherwise a failed run leaves its keys in Redis forever.
    await cleanup()
  }

  head('Итог')
  info(`механика очереди (заглушка, НЕ реальная скорость): ${summary.rate} док/с · пик ${summary.peakBacklog} · разгрузка ${(summary.elapsed / 1000).toFixed(1)} с`)
  if (pace) info(`реальный предел (лимитер Б24): ≈ ${pace.perHourPerPortal} документов в час на портал`)
  if (failures.length) {
    console.log(`\n${C.r}ПРОВАЛ: ${failures.length}${C.x}`)
    failures.forEach(f => console.log(`  - ${f}`))
  } else {
    console.log(`\n${C.g}Все проверки пройдены — очередь держит нагрузку и разгружается полностью.${C.x}`)
  }

  await cleanup()
  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => {
  console.error(`${C.r}Прогон упал:${C.x}`, e?.message ?? e)
  process.exit(1)
})
