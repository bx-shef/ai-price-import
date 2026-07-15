// Queue runtime role — pure env parsing, so the plugin stays thin and testable.
// Ported from bx-shef/client-bank-alfa-by (scale-out roles). See CLAUDE.md.
//
// One image, three roles by env:
//   - single container (default): workers ON + cron ON — one instance does it all;
//   - HTTP/primary container: QUEUE_WORKERS=0 (serves the API + runs the event worker),
//     throughput jobs drained by dedicated worker containers;
//   - worker container: QUEUE_CRON=0 (+ RUN_MIGRATION=0), scaled to N replicas —
//     all pull from the same Redis, so adding replicas adds throughput.
//
// The b24-events worker rides on the CRON (primary) instance ONLY — install/uninstall
// must stay single-instance/ordered (the tombstone guard is TOCTOU-free only under one
// events consumer). Throughput queues (extract/agent/crm-sync) scale on `worker` replicas.
// Per-queue concurrency is a SEPARATE concern (QUEUE_EXTRACT/AGENT/CRM_CONCURRENCY —
// see worker.ts queueConcurrency, #95); roles here only decide WHICH workers run.

export interface QueueRuntime {
  /** Drain the throughput queues (extract/agent/crm-sync) in this instance. */
  workers: boolean
  /** Run the event worker (+ future cron) in this instance — must be exactly ONE
   *  instance so install/uninstall never reorder across replicas. */
  cron: boolean
}

/** A boolean env flag: unset/empty → default; `0/false/no/off` (any case) → false. */
export function envFlag(value: string | undefined, dflt: boolean): boolean {
  if (value === undefined || value.trim() === '') return dflt
  return !/^(0|false|no|off)$/i.test(value.trim())
}

/** Resolve the queue role from the environment (defaults = single-container). */
export function queueRuntimeConfig(env: NodeJS.ProcessEnv = process.env): QueueRuntime {
  return {
    workers: envFlag(env.QUEUE_WORKERS, true),
    cron: envFlag(env.QUEUE_CRON, true)
  }
}
