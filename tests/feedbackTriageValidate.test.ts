import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// CI-gate for the feedback-triage kit's offline validator (docs/FEEDBACK_TRIAGE_AGENT.md §8.3).
// scripts/validate-docs.sh keeps the doc + scripts consistent: bash -n, shellcheck, a BEHAVIOURAL
// run of the real `_api` through a mocked curl (happy-path + 8 guard cases — token/HTTP/privacy/
// slug/num), the rate-limit rule pointer to CLAUDE.md, an anchored privacy-guard grep, and the
// `> Last reviewed` header. Running it here wires it into `pnpm test` / `pnpm check` / CI so
// regressions (a dropped privacy-guard, the trap-return bug class, a drifted default) fail
// automatically instead of only on a manual run — no ci.yml change needed. Ported from the
// reference client-bank-alfa-by (feedback-triage kit).
const REPO_ROOT = process.cwd()

/** Is a POSIX `bash` reachable? (Windows dev without Git Bash/WSL → skip, like the .ps1 SKIPs.) */
function hasBash(): boolean {
  return spawnSync('bash', ['-c', 'exit 0']).status === 0
}

describe('feedback-triage offline validator', () => {
  it.skipIf(!hasBash())('scripts/validate-docs.sh exits 0', () => {
    const res = spawnSync('bash', [join('scripts', 'validate-docs.sh')], {
      cwd: REPO_ROOT,
      encoding: 'utf-8'
    })
    // Surface the validator's own output on failure so the CI log pinpoints the failing step.
    expect(res.status, res.stdout + res.stderr).toBe(0)
  })
})
