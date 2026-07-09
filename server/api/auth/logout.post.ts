import { OP_COOKIE } from '../../utils/operatorSession'

// POST /api/auth/logout — clear the operator session cookie.
export default defineEventHandler((event) => {
  deleteCookie(event, OP_COOKIE, { path: '/' })
  return { ok: true }
})
