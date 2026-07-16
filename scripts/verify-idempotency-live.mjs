// Dev-only live verify of the crm-sync idempotency MARKER path (#135) on the seeded test portal
// (webhook, scope crm). Runs the REAL runCrmSync twice with the SAME jobId and asserts the second
// run FINDS the created entity by its marker (originId/originatorId) → created=false, no duplicate.
// Not part of SSG / CI. Run: node --experimental-strip-types --import ./scripts/lib/alias-register.mjs scripts/verify-idempotency-live.mjs
import { readFileSync } from 'node:fs'
import { runCrmSync } from '../server/queue/crmSyncCore.ts'
import { findExistingItemId } from '../server/utils/originLookup.ts'
import { originSearchFilter } from '../server/utils/originMarker.ts'
import { findCompanyByTaxId } from '../server/utils/companyLookup.ts'
import { findProduct } from '../server/utils/productLookup.ts'
import { fetchVatRates } from '../server/utils/portalVat.ts'
import { fetchCurrencies } from '../server/utils/portalCurrency.ts'
import { createTargetItem, setProductRows } from '../server/utils/crmWrite.ts'

const readEnv = (file, key) => {
  const line = readFileSync(file, 'utf8').split('\n').find(l => l.startsWith(key + '='))
  if (!line) throw new Error(`${key} not in ${file}`)
  return line.slice(key.length + 1).trim()
}
const WEBHOOK = readEnv('.env.b24test', 'B24_TEST_WEBHOOK').replace(/\/?$/, '/')
const call = async (method, params = {}) => {
  const r = await fetch(`${WEBHOOK}${method}.json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${j.error} ${j.error_description || ''}`)
  return j.result
}
const listCall = async (method, params) => {
  const res = await call(method, params)
  return Array.isArray(res) ? res : (res?.items ?? [])
}

const mapping = {
  article: { field: '', kind: 'text' }, product: { by: 'name', onMissing: 'freeform' },
  units: { dictionary: { шт: 796 }, defaultCode: 796, autoCreate: false },
  saveFile: false, routingRules: [], defaultTarget: { entityTypeId: 2, categoryId: 0 }
}
const doc = {
  documentType: 'накладная', currency: 'BYN', priceIncludesVat: true,
  supplier: { name: '[TEST] Идемпотентность', taxId: '190000000' },
  items: [{ name: '[TEST] Позиция', price: 100, quantity: 2, unit: 'шт', vatRate: null }]
}

const deps = {
  findExisting: (etid, filter) => findExistingItemId(etid, filter, call),
  findCompanyByTaxId: t => findCompanyByTaxId(t, call),
  findProduct: it => findProduct(it, mapping, call),
  portalVatRates: () => fetchVatRates(listCall),
  portalCurrencies: () => fetchCurrencies(call),
  createTarget: (t, f) => createTargetItem(t, f, call),
  setRows: (e, i, r) => setProductRows(e, i, r, call),
  reportErrors: async m => console.log('  ⚠ errors →', m)
}

const jobId = 'verify-idem-' + Math.floor(Date.now() / 1000) // fixed across both runs
console.log('jobId =', jobId)
const filter = originSearchFilter(2, jobId) // {=originId, =originatorId:'ai-price-import'}

let createdId = null
try {
  const r1 = await runCrmSync(jobId, doc, mapping, { documentType: 'накладная', text: '' }, deps)
  console.log('run #1 →', JSON.stringify({ created: r1.created, entityId: r1.entityId, idempotent: r1.idempotent, errors: r1.errors }))
  createdId = r1.entityId
  if (!r1.created || !createdId) throw new Error('run #1 did not create')

  const found = await findExistingItemId(2, filter, call)
  console.log('direct findExistingItemId →', found, found === createdId ? 'OK (matches)' : 'MISMATCH')

  const r2 = await runCrmSync(jobId, doc, mapping, { documentType: 'накладная', text: '' }, deps)
  console.log('run #2 →', JSON.stringify({ created: r2.created, entityId: r2.entityId, idempotent: r2.idempotent }))

  const all = await call('crm.item.list', { entityTypeId: 2, filter, select: ['id'] })
  const count = (all?.items ?? []).length
  console.log('deals carrying this marker =', count)

  const pass = r1.created && !r2.created && r2.entityId === createdId && found === createdId && count === 1
  console.log(pass ? '\n✅ PASS: маркер найден, дубль НЕ создан (created=false на повторе)' : '\n❌ FAIL')
} finally {
  if (createdId) {
    await call('crm.item.delete', { entityTypeId: 2, id: createdId }).then(() => console.log('cleanup: deleted deal', createdId)).catch(e => console.log('cleanup failed:', e.message))
  }
}
