import { onScopeDispose } from 'vue'
import { B24PullClientManager } from '@bitrix24/b24jssdk'
import { useB24 } from './useB24'
import { LANDING_MARKET_CODE } from '~/utils/landing'
import { SETTINGS_RELOAD_COMMAND, buildSettingsReloadEvent, isSettingsReloadCommand } from '~/utils/settingsSync'

// Cross-instance settings sync (pattern from bitrix24/b24-ai-starter). After an admin saves settings,
// `notifyReload()` fires `pull.application.event.add` on the app's pull channel; other open instances
// subscribed via `subscribeReload()` re-read settings live — so a second admin's form doesn't overwrite
// with stale values. Both sides are BEST-EFFORT and never throw: the send is a plain REST call, and the
// receive needs the portal's pull server (may be off / unavailable), so it degrades to a no-op.
// ⚠ Pull channel semantics (module id / command routing) are portal-specific — verify on a live portal.

/** App code as registered on the portal = the pull `MODULE_ID` / subscribe `moduleId`. */
function appModuleId(): string {
  return String(useRuntimeConfig().public.b24MarketCode || LANDING_MARKET_CODE)
}

export function useSettingsSync() {
  const { init, get } = useB24()

  /** Tell other open instances to reload settings. Best-effort — a pull failure never blocks a save. */
  async function notifyReload(): Promise<void> {
    try {
      await init()
      const frame = get()
      if (!frame) return
      await frame.callMethod('pull.application.event.add', buildSettingsReloadEvent(appModuleId()))
    } catch {
      // pull unavailable / not framed → skip; cross-instance sync is a nicety, not correctness
    }
  }

  /**
   * Subscribe to the reload command; calls `onReload` when another instance saves. Returns an
   * unsubscribe fn (also auto-disposed with the calling scope). Best-effort: if the portal pull
   * client can't start, this is a silent no-op.
   */
  function subscribeReload(onReload: () => void): () => void {
    let dispose: (() => void) | null = null
    let pull: InstanceType<typeof B24PullClientManager> | null = null

    void (async () => {
      try {
        await init()
        const frame = get()
        if (!frame) return
        const moduleId = appModuleId()
        pull = new B24PullClientManager({ b24: frame, restApplication: moduleId })
        const off = pull.subscribe({
          moduleId,
          command: SETTINGS_RELOAD_COMMAND,
          callback: (message: { command?: string }) => {
            if (isSettingsReloadCommand(message?.command)) onReload()
          }
        })
        dispose = off
        await pull.start()
      } catch {
        // pull server off / not framed → no live sync; the explicit Save/reload still works
      }
    })()

    const unsubscribe = () => {
      try {
        dispose?.()
        pull?.destroy?.()
      } catch { /* ignore */ }
      dispose = null
      pull = null
    }
    onScopeDispose(unsubscribe)
    return unsubscribe
  }

  return { notifyReload, subscribeReload }
}
