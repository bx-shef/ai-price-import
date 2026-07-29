import { describe, expect, it } from 'vitest'
import { FIRST_LOAD_RETRY_MS, MAX_POLL_FAILURES, POLL_MS, nextPollDelay } from '../app/utils/pollBackoff'

describe('nextPollDelay', () => {
  it('первая загрузка не удалась → паузы растут по таблице, и последнее значение реально достижимо', () => {
    const delays = Array.from({ length: MAX_POLL_FAILURES }, (_, failures) =>
      nextPollDelay({ firstLoadOk: false, hasActive: false, failures }))
    expect(delays).toEqual(FIRST_LOAD_RETRY_MS)
  })

  it('пока список не загрузился — таймер ставится даже без активных задач (это и есть фикс #268)', () => {
    expect(nextPollDelay({ firstLoadOk: false, hasActive: false, failures: 0 })).toBe(FIRST_LOAD_RETRY_MS[0])
  })

  it('список загрузился: есть активные — обычный шаг, нет активных — цикл останавливается', () => {
    expect(nextPollDelay({ firstLoadOk: true, hasActive: true, failures: 3 })).toBe(POLL_MS)
    expect(nextPollDelay({ firstLoadOk: true, hasActive: false, failures: 0 })).toBeNull()
  })

  it('после предельного числа подряд неудач цикл останавливается в любом состоянии', () => {
    expect(nextPollDelay({ firstLoadOk: false, hasActive: false, failures: MAX_POLL_FAILURES })).toBeNull()
    expect(nextPollDelay({ firstLoadOk: true, hasActive: true, failures: MAX_POLL_FAILURES })).toBeNull()
  })

  it('таблица пауз согласована с пределом неудач — иначе появится мёртвый хвост или вечный ретрай', () => {
    expect(FIRST_LOAD_RETRY_MS.length).toBe(MAX_POLL_FAILURES)
  })
})
