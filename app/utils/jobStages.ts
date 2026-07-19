// Pure per-job STAGE model for the /app progress UI. The backend advances a job through
// queued → extracting → processing → done/error (see server JobStatus / jobStatus.ts). This maps
// any status to an ordered stepper + a coarse percent so the in-portal home can show, per file,
// which stage it's on (like the demo, but with the real pipeline stages). Pure + tested.

import type { JobStatus } from './jobStatus'

export type StepState = 'done' | 'active' | 'pending' | 'error'
export interface JobStep { key: 'extract' | 'recognize' | 'done', label: string, state: StepState }

export interface JobProgress {
  /** Coarse completion 0..100 for a progress bar. */
  percent: number
  /** Human label for the current stage (what's happening now). */
  label: string
  /** Ordered stepper for the pipeline. */
  steps: JobStep[]
  /** Job has reached a terminal state (done or error). */
  terminal: boolean
  /** Job ended in error. */
  failed: boolean
}

const STEP_DEFS: Array<{ key: JobStep['key'], label: string }> = [
  { key: 'extract', label: 'Извлечение текста' },
  { key: 'recognize', label: 'Распознавание и запись' },
  { key: 'done', label: 'Готово' }
]

// Which step is «active» for each non-terminal status (index into STEP_DEFS). queued marks the first
// step active too (so a just-queued file looks alive, not stalled) — the label still reads «В очереди».
// done/error are handled specially below.
const ACTIVE_INDEX: Record<string, number> = {
  queued: 0,
  extracting: 0,
  processing: 1
}

// Coarse percent per status — monotonic so the bar only moves forward.
const PERCENT: Record<string, number> = {
  queued: 8,
  extracting: 40,
  processing: 75,
  done: 100,
  error: 100
}

/** Map a job status to a stepper + percent for the progress UI. Never throws (unknown → queued-like). */
export function jobProgress(status: JobStatus | string): JobProgress {
  const failed = status === 'error'
  const isDone = status === 'done'
  const terminal = isDone || failed
  const activeIndex = status in ACTIVE_INDEX ? ACTIVE_INDEX[status]! : -1

  const steps: JobStep[] = STEP_DEFS.map((def, i) => {
    let state: StepState
    if (isDone) {
      state = 'done'
    } else if (failed) {
      // The status doesn't carry WHICH stage failed; mark the last active stage as error and keep
      // earlier ones done. Fall back to the first step when nothing had started (queued → error).
      const failIndex = Math.max(0, activeIndex)
      state = i < failIndex ? 'done' : i === failIndex ? 'error' : 'pending'
    } else if (activeIndex < 0) {
      state = 'pending' // queued — nothing running yet
    } else if (i < activeIndex) {
      state = 'done'
    } else if (i === activeIndex) {
      state = 'active'
    } else {
      state = 'pending'
    }
    return { key: def.key, label: def.label, state }
  })

  const label = failed
    ? 'Ошибка'
    : isDone
      ? 'Готово'
      : status === 'queued'
        ? 'В очереди'
        : (STEP_DEFS[activeIndex]?.label ?? 'В очереди')

  return {
    percent: status in PERCENT ? PERCENT[status]! : 8,
    label,
    steps,
    terminal,
    failed
  }
}
