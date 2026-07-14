// Node ESM resolve hook so dev scripts can import the app/server TypeScript directly
// (Nuxt `~/…` aliases + extensionless relative imports). Registered via alias-register.mjs
// (--import) — see package.json `live:crm`. Requires --experimental-strip-types (Node ≥ 22.6).
// Dev-only (recon/live-test scripts); not part of the SSG build.
import { pathToFileURL, fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { dirname, resolve as presolve } from 'node:path'

const ROOT = process.cwd()

/** Resolve a bare filesystem path to an existing file, trying .ts, then .mjs, then index.ts. */
function toUrl(target) {
  if (!existsSync(target)) {
    if (existsSync(target + '.ts')) target += '.ts'
    else if (existsSync(target + '.mjs')) target += '.mjs'
    else if (existsSync(presolve(target, 'index.ts'))) target = presolve(target, 'index.ts')
  }
  return pathToFileURL(target).href
}

export async function resolve(specifier, context, next) {
  // Nuxt aliases: `~/x` and `@/x` → app/x ; `~~/x` and `@@/x` → repo root/x.
  if (specifier.startsWith('~/') || specifier.startsWith('@/')) {
    return { url: toUrl(presolve(ROOT, 'app', specifier.slice(2))), shortCircuit: true }
  }
  if (specifier.startsWith('~~/') || specifier.startsWith('@@/')) {
    return { url: toUrl(presolve(ROOT, specifier.slice(3))), shortCircuit: true }
  }
  // Extensionless relative imports between .ts files.
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const base = dirname(fileURLToPath(context.parentURL))
    const target = presolve(base, specifier)
    if (!existsSync(target) && (existsSync(target + '.ts') || existsSync(presolve(target, 'index.ts')))) {
      return { url: toUrl(target), shortCircuit: true }
    }
  }
  return next(specifier, context)
}
