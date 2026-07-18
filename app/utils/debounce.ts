// Tiny debouncer for autosave — pure/testable glue around setTimeout. `schedule()` (re)arms the
// timer; `flush()` fires immediately if armed (e.g. on unmount / explicit save); `cancel()` drops a
// pending run without firing. Extracted from the component so the timing logic is unit-tested with
// fake timers (repo convention: чистое ядро в app/utils, покрытое тестами).

export interface Debouncer {
  /** (Re)arm the timer — the action runs `delayMs` after the LAST schedule() call. */
  schedule: () => void
  /** Fire now if a run is pending (and clear the timer); no-op when nothing is armed. */
  flush: () => void
  /** Drop a pending run without firing it. */
  cancel: () => void
  /** Whether a run is currently armed. */
  pending: () => boolean
}

/**
 * Build a debouncer for `action`, coalescing bursts of `schedule()` into one call `delayMs` after
 * the last one. `flush()` runs the action once if armed; a non-positive delay still defers to a
 * 0-timeout (never runs synchronously inside schedule, so a reactive watcher can't re-enter).
 */
export function createDebouncer(action: () => void, delayMs: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function run(): void {
    clear()
    action()
  }

  return {
    schedule() {
      clear()
      timer = setTimeout(run, Math.max(0, delayMs))
    },
    flush() {
      if (timer !== null) run()
    },
    cancel: clear,
    pending: () => timer !== null
  }
}
