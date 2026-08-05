import { onScopeDispose, readonly, ref } from 'vue'
import { B24PullClientManager } from '@bitrix24/b24jssdk'
import { useB24 } from './useB24'
import { LANDING_MARKET_CODE } from '~/utils/landing'
import { SETTINGS_RELOAD_COMMAND, buildSettingsReloadEvent } from '~/utils/settingsSync'

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

/**
 * Почему у канала есть НАБЛЮДАЕМОЕ состояние (#443).
 *
 * ⚠ Обе стороны были обёрнуты пустыми `catch`, и это делало канал неотличимым от работающего: если
 * подписка не поднялась (pull-сервер портала выключен, неверный `MODULE_ID`, приложение открыто вне
 * фрейма), экран импорта просто никогда не обновлялся после сохранения настроек — ровно тот симптом,
 * с которого заведена задача. Молчаливая деградация «на всякий случай» здесь стоит дороже отказа:
 * чинить нечего, потому что поломки не видно.
 * ⚠ Наружу отдаётся СОСТОЯНИЕ, а не исключение: канал остаётся best-effort и сохранение настроек не
 * роняет. Разница ровно в одном — теперь про его неработоспособность можно узнать.
 */
export type SettingsSyncState = 'idle' | 'live' | 'unavailable'

/** Причина отказа — только КЛАСС, без текста ошибки портала: он вправе процитировать параметры вызова. */
export type SettingsSyncFailure = 'not-framed' | 'pull-failed' | 'send-failed'

export function useSettingsSync() {
  const { init, get } = useB24()
  const state = ref<SettingsSyncState>('idle')
  const failure = ref<SettingsSyncFailure | null>(null)

  function degrade(reason: SettingsSyncFailure) {
    state.value = 'unavailable'
    failure.value = reason
    // Один раз на причину, а не на каждую попытку: канал best-effort, и журнал не должен шуметь.
    console.warn(`[settings-sync] живое обновление настроек недоступно (${reason})`)
  }

  /** Tell other open instances to reload settings. Best-effort — a pull failure never blocks a save. */
  async function notifyReload(): Promise<void> {
    try {
      await init()
      const frame = get()
      if (!frame) return degrade('not-framed')
      // actions.v2.call.make — the non-deprecated replacement for frame.callMethod() (removed in SDK 2.0).
      await frame.actions.v2.call.make({ method: 'pull.application.event.add', params: buildSettingsReloadEvent(appModuleId()) })
    } catch {
      // pull unavailable / not framed → соседние вкладки не обновятся; сохранение уже прошло.
      degrade('send-failed')
    }
  }

  /**
   * Subscribe to the reload command; calls `onReload` when another instance saves. Returns an
   * unsubscribe fn (also auto-disposed with the calling scope). Best-effort: if the portal pull
   * client can't start, this is a silent no-op.
   */
  function subscribeReload(onReload: () => void): () => void {
    let disposed = false
    let dispose: (() => void) | null = null
    let pull: InstanceType<typeof B24PullClientManager> | null = null

    const teardown = () => {
      try {
        dispose?.()
        pull?.destroy?.()
      } catch { /* ignore */ }
      dispose = null
      pull = null
    }

    void (async () => {
      try {
        await init()
        if (disposed) return
        const frame = get()
        if (!frame) return degrade('not-framed')
        const moduleId = appModuleId()
        pull = new B24PullClientManager({ b24: frame, restApplication: moduleId })
        // The SDK dispatches this callback ONLY for the subscribed command bucket (reload.options) —
        // it passes (params, extra, command, meta), so react unconditionally; there's no {command} arg.
        dispose = pull.subscribe({ moduleId, command: SETTINGS_RELOAD_COMMAND, callback: () => onReload() })
        // disposed mid-await → drop the just-built client
        if (disposed) {
          teardown()
          return
        }
        await pull.start()
        if (disposed) teardown()
        else state.value = 'live'
      } catch {
        // pull server off / not framed → живого обновления нет; ручная перезагрузка работает.
        degrade('pull-failed')
      }
    })()

    const unsubscribe = () => {
      disposed = true
      teardown()
    }
    onScopeDispose(unsubscribe)
    return unsubscribe
  }

  // `state`/`failure` — только для наблюдения (журнал, будущая подсказка на экране). Ни один
  // вызывающий не обязан их читать: канал остаётся best-effort.
  return { notifyReload, subscribeReload, state: readonly(state), failure: readonly(failure) }
}
