import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// #411. Кнопку сброса счётчиков убрали у не-админа — и ровно здесь появляется соблазн, о котором
// сказано в задаче: «раз кнопки всё равно нет, серверную проверку можно упростить». Признак
// администратора приезжает В БРАУЗЕР (`IS_ADMIN` фрейма), то есть подконтролен клиенту; скрытая
// кнопка не мешает послать запрос руками. Серверный гейт — единственная настоящая проверка.
//
// ⚠ Гард проверяет не наличие строки, а ПОРЯДОК: отказ обязан стоять ДО разрушительного вызова.
// Перенос гейта вниз оставил бы код с обеими строками и обнулял бы счётчики перед отказом.
const ROUTE = new URL('../server/api/import/metrics-reset.post.ts', import.meta.url).pathname
const src = readFileSync(ROUTE, 'utf8')

describe('#411: обнуление счётчиков остаётся admin-only на сервере', () => {
  it('проверка админа стоит до сброса и отвечает 403', () => {
    const gate = src.indexOf('member.admin')
    const reset = src.indexOf('resetCounters(')
    expect(gate, 'гейт администратора исчез из роута').toBeGreaterThan(-1)
    expect(reset).toBeGreaterThan(-1)
    expect(gate, 'гейт администратора стоит ПОСЛЕ обнуления').toBeLessThan(reset)
    expect(src.slice(gate, reset)).toContain('403')
  })

  it('member_id берётся из проверенного токена, а не из тела запроса', () => {
    // Иначе портал мог бы обнулить чужие счётчики, и admin-гейт защищал бы не то.
    expect(src).toContain('member.memberId')
    expect(src).not.toMatch(/readBody|getQuery/)
  })
})
