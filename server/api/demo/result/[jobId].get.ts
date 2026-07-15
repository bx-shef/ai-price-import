import { demoJobStore } from '../../../utils/demoJobs'

// GET /api/demo/result/:jobId — poll an async demo AI job (GH #70). Cheap O(1) lookup by
// an unguessable UUID, so it is not rate-limited (only submit consumes the 3/10min quota).
// 200 {status:'pending'} | 200 {status:'done', result} | 422 {status:'error'} | 404 gone.
export default defineEventHandler(async (event) => {
  const jobId = getRouterParam(event, 'jobId') ?? ''
  const now = Date.now()
  await demoJobStore.sweep(now)
  const state = await demoJobStore.get(jobId, now)
  if (!state) {
    setResponseStatus(event, 404)
    return { error: 'Задача не найдена или устарела. Загрузите файл заново.' }
  }
  if (state.status === 'error') {
    setResponseStatus(event, 422)
    return { status: 'error', error: state.error }
  }
  return state // {status:'pending'} | {status:'done', result}
})
