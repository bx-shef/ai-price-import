// @vitest-environment nuxt
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import AppRatingModal from '~/components/AppRatingModal.vue'

// The modal delays its server check ~10s after the trigger flips, so a fresh import result is seen
// first. Mock useAppRating to observe when check() actually fires.
const check = vi.fn()
const show = ref(false)
mockNuxtImport('useAppRating', () => () => ({
  show,
  check,
  markPrompted: vi.fn(),
  openMarket: vi.fn(),
  dismiss: vi.fn()
}))

describe('AppRatingModal — delayed prompt', () => {
  afterEach(() => {
    vi.useRealTimers()
    check.mockClear()
    show.value = false
  })

  it('does NOT check() immediately; fires once ~10s after the trigger flips true', async () => {
    // Mount under real timers (avoid suspense hang), then fake-time only the delay.
    const w = await mountSuspended(AppRatingModal, { props: { trigger: false } })
    vi.useFakeTimers()
    await w.setProps({ trigger: true })
    expect(check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(9000)
    expect(check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1500)
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('cancels the pending prompt on unmount (no check after teardown)', async () => {
    const w = await mountSuspended(AppRatingModal, { props: { trigger: false } })
    vi.useFakeTimers()
    await w.setProps({ trigger: true })
    w.unmount()
    await vi.advanceTimersByTimeAsync(11000)
    expect(check).not.toHaveBeenCalled()
  })
})
