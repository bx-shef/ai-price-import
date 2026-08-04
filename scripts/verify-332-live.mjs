// Live verification of the #332 byte-upload Disk-download core against the seeded test portal.
// Dev-only. Proves the RISKY part — reading a Disk file's bytes back via `disk.file.get` → DOWNLOAD_URL
// → fetch — using the SAME pure `downloadDiskFile` the runtime calls (there over the per-portal OAuth
// frame token; here over the webhook). Round-trips: upload a tiny file → download via downloadDiskFile
// → assert bytes match → delete. With `--commit` (and GITHUB_FEEDBACK_* set) it also really commits the
// file into the private feedback repo via `commitFeedbackFile`.
//
//   pnpm verify:332            # upload → download round-trip → delete
//   pnpm verify:332 --commit   # ALSO commit the file to the private feedback repo (needs GITHUB_FEEDBACK_*)
//
// Reads git-ignored .env.b24test (B24_TEST_WEBHOOK). Webhook scopes must include `disk`.
// SCOPE: this drives the download over the WEBHOOK. The SSRF-guard reject and streaming cap are covered
// by the unit tests (tests/diskDownload.test.ts), not here. ⚠ The production path uses the per-portal
// OAuth frame token (makeBareTokenSdkCall), whose disk.file.get may return a differently-shaped
// DOWNLOAD_URL — verify that end-to-end on a real installed portal (via the feedback widget) too.
import { readFileSync } from 'node:fs'
import { downloadDiskFile } from '../server/utils/diskDownload.ts'
import { uploadFile } from '../server/utils/disk.ts'
import { commitFeedbackFile } from '../server/utils/feedbackGithub.ts'
import { resolveFeedbackConfig } from '../server/utils/feedbackConfig.ts'
import { feedbackFilePath } from '../app/utils/feedback.ts'

const argv = process.argv.slice(2)
const doCommit = argv.includes('--commit')

const readEnv = (file, key) => {
  const m = readFileSync(file, 'utf8').match(new RegExp(`^\\s*${key}=(.+)$`, 'm'))
  if (!m) throw new Error(`${key} not found in ${file}`)
  return m[1].trim().replace(/^["']|["']$/g, '')
}
const WEBHOOK = readEnv('.env.b24test', 'B24_TEST_WEBHOOK')
// Portal host for the SSRF guard (DOWNLOAD_URL must be on this host).
const DOMAIN = new URL(WEBHOOK).host

const call = async (method, params = {}) => {
  const r = await fetch(`${WEBHOOK}${method}.json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${j.error} ${j.error_description || ''}`)
  return j.result
}
const binFetch = url => fetch(url)

const ok = m => console.log(`\x1b[32m✓\x1b[0m ${m}`)
const die = (m) => {
  console.error(`\x1b[31m✗ ${m}\x1b[0m`)
  process.exit(1)
}

const stamp = Date.now()
const content = `ai-price-import #332 disk round-trip ${stamp}\n`
const base64In = Buffer.from(content, 'utf8').toString('base64')
const fileName = `ai-price-import-332-test-${stamp}.txt`

const run = async () => {
  // 1. Find the app's common Disk storage root to upload into.
  const storages = await call('disk.storage.getlist', {})
  const common = (storages ?? []).find(s => s.ENTITY_TYPE === 'common') ?? storages?.[0]
  if (!common?.ROOT_OBJECT_ID) die('no Disk storage with a root folder (need `disk` scope)')
  const rootId = Number(common.ROOT_OBJECT_ID)
  ok(`Disk storage: ${common.NAME} (root ${rootId})`)

  // 2. Upload a tiny test file, get its id.
  const ref = await uploadFile(rootId, fileName, base64In, call)
  if (!ref?.id) die('uploadFile returned no id')
  ok(`uploaded ${fileName} → file id ${ref.id}`)

  let downloaded
  try {
    // 3. Download it back via the SAME pure core the runtime uses.
    downloaded = await downloadDiskFile(ref.id, DOMAIN, call, binFetch)
    if (!downloaded) die('downloadDiskFile returned null (check DOWNLOAD_URL host / disk scope)')
    ok(`downloaded ${downloaded.size} bytes as base64`)

    // 4. Assert byte-for-byte round-trip.
    const back = Buffer.from(downloaded.base64, 'base64').toString('utf8')
    if (back !== content) die(`round-trip MISMATCH: got ${JSON.stringify(back)}`)
    ok('bytes match the original (round-trip verified)')
    if (downloaded.name !== fileName) die(`name mismatch: ${downloaded.name}`)
    ok(`name preserved: ${downloaded.name}`)

    // 5. Optional: really commit into the private feedback repo.
    if (doCommit) {
      const cfg = resolveFeedbackConfig(process.env)
      if (!cfg) die('--commit set but GITHUB_FEEDBACK_TOKEN/REPO not configured')
      const path = feedbackFilePath(`test-${stamp}`, downloaded.name)
      const res = await commitFeedbackFile(cfg, path, downloaded.base64, `#332 live verify ${stamp}`, globalThis.fetch)
      if (!res.ok) die(`commitFeedbackFile failed: status ${res.status}`)
      ok(`committed to ${cfg.repo}: ${res.htmlUrl || path}`)
    } else {
      console.log('  (skip repo commit — pass --commit with GITHUB_FEEDBACK_* to test it)')
    }
  } finally {
    // 6. Clean up the test file so the portal stays tidy.
    await call('disk.file.delete', { id: ref.id }).then(() => ok('cleaned up test file')).catch(() => {})
  }
  console.log('\n\x1b[32mAll #332 disk-download checks passed.\x1b[0m')
}

run().catch(e => die(e.message))
