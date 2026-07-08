import { checkBackendEnv } from '../utils/envCheck'

// Validate env on boot: log errors/warnings, never crash (no-op at prerender).
export default defineNitroPlugin(() => {
  if (import.meta.prerender) return
  const { errors, warnings } = checkBackendEnv(process.env)
  for (const w of warnings) console.warn('[env] warning:', w)
  for (const e of errors) console.error('[env] ERROR:', e)
})
