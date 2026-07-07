import { healthInfo } from '~/utils/build'

// Public liveness endpoint: GET /api/health. No secrets.
export default defineEventHandler(() => {
  const commit = useRuntimeConfig().public.commitSha as string
  return {
    ...healthInfo(commit),
    time: new Date().toISOString()
  }
})
