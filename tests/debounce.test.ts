import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDebouncer } from '../app/utils/debounce'

describe('createDebouncer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces a burst of schedule() into ONE run after the last call', () => {
    const fn = vi.fn()
    const d = createDebouncer(fn, 500)
    d.schedule()
    vi.advanceTimersByTime(300)
    d.schedule() // re-arm — timer restarts
    vi.advanceTimersByTime(300)
    expect(fn).not.toHaveBeenCalled() // only 600ms since first, 300ms since last
    vi.advanceTimersByTime(200)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not run synchronously inside schedule()', () => {
    const fn = vi.fn()
    createDebouncer(fn, 0).schedule()
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('flush() fires immediately when armed and clears the timer', () => {
    const fn = vi.fn()
    const d = createDebouncer(fn, 1000)
    d.schedule()
    expect(d.pending()).toBe(true)
    d.flush()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(d.pending()).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(fn).toHaveBeenCalledTimes(1) // timer was cleared — no second run
  })

  it('flush() is a no-op when nothing is armed', () => {
    const fn = vi.fn()
    createDebouncer(fn, 1000).flush()
    expect(fn).not.toHaveBeenCalled()
  })

  it('cancel() drops a pending run without firing', () => {
    const fn = vi.fn()
    const d = createDebouncer(fn, 1000)
    d.schedule()
    d.cancel()
    expect(d.pending()).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(fn).not.toHaveBeenCalled()
  })
})
