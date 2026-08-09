import { onScopeDispose, readonly, ref } from 'vue'
import { B24PullClientManager } from '@bitrix24/b24jssdk'
import { useB24 } from './useB24'
import { LANDING_MARKET_CODE } from '~/utils/landing'
import { SETTINGS_RELOAD_COMMAND, buildSettingsReloadEvent } from '~/utils/settingsSync'
import { ANNOUNCEMENT_PULL_COMMAND } from '~/utils/announcementPull'

// ОБЩАЯ МАШИНЕРИЯ PULL-КАНАЛА портала. Изначально это была только синхронизация настроек (отсюда имя
// файла и типов), но с #478 через ту же трубу ходит и сигнал «проверь объявление издателя» — каналов
// два, труба одна:
//   • `reload.options`     — админ сохранил настройки, шлёт САМ ПОРТАЛ из фрейма (#443);
//   • `announcement.check` — издатель опубликовал объявление, шлёт НАШ СЕРВЕР всем порталам (#478).
// Обе стороны BEST-EFFORT и никогда не бросают: отправка — обычный REST-вызов, приём требует
// pull-сервера портала (может быть выключен), и всё это вырождается в no-op.
// ⚠ Pull channel semantics (module id / command routing) are portal-specific — verify on a live portal.

/** Предел ожидания рассылки — дальше закрываем форму, не заставляя админа ждать портал. */
const NOTIFY_TIMEOUT_MS = 3000

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

  // ⚠ Отказ объявляется ОДИН РАЗ НА ПРИЧИНУ, а не на попытку: канал best-effort, а `notifyReload`
  // зовётся на каждое сохранение — иначе портал с выключенным pull получал бы строку в журнале при
  // каждом нажатии «Сохранить», и полезное сообщение утонуло бы в собственном шуме.
  const announced = new Set<string>()
  // ⚠ В строке журнала называется КАНАЛ, а не «настройки». Пока труба обслуживала один механизм,
  // захардкоженный текст был верен; с появлением второго (#478) отказ подписки НА ОБЪЯВЛЕНИЕ писал
  // бы «недоступно обновление настроек» — то есть уводил бы отладку к другому механизму. Ровно то
  // молчаливое враньё, против которого заведена вся наблюдаемость канала.
  function degrade(reason: SettingsSyncFailure, channel = 'settings') {
    state.value = 'unavailable'
    failure.value = reason
    const key = `${channel}:${reason}`
    if (announced.has(key)) return
    announced.add(key)
    console.warn(`[pull-sync] живой канал недоступен: ${channel} (${reason})`)
  }

  /** Tell other open instances to reload settings. Best-effort — a pull failure never blocks a save. */
  //
  // ⚠ Ожидание ОГРАНИЧЕНО по времени. Вызывающий ждёт эту рассылку перед закрытием слайдера (иначе
  // сообщение теряется вместе с фреймом), и без предела медленный портал держал бы админа перед
  // формой, которая уже сказала «Сохранено ✓», но не закрывается — «сохранил и завис». Рассылка
  // best-effort: не успела — соседи узнают при следующем открытии экрана, это дешевле зависания.
  async function notifyReload(): Promise<void> {
    try {
      await init()
      const frame = get()
      if (!frame) return degrade('not-framed')
      // actions.v2.call.make — the non-deprecated replacement for frame.callMethod() (removed in SDK 2.0).
      const sent = frame.actions.v2.call.make({ method: 'pull.application.event.add', params: buildSettingsReloadEvent(appModuleId()) })
      const timedOut = Symbol('timeout')
      const race = await Promise.race([
        sent.then(() => 'ok' as const),
        new Promise<typeof timedOut>(resolve => setTimeout(() => resolve(timedOut), NOTIFY_TIMEOUT_MS))
      ])
      if (race === timedOut) return degrade('send-failed')
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
    return subscribeCommand(SETTINGS_RELOAD_COMMAND, onReload)
  }

  /**
   * Подписка на сигнал «проверь объявление издателя» (#478).
   *
   * ⚠ Та же труба, ДРУГАЯ команда — и отдельная функция именно поэтому: подписчик получает вызовы
   * только своей команды, и один обработчик на обе означал бы поход за настройками на каждое
   * объявление и наоборот. Отправитель тут не портал, а наш сервер (рассылает всем порталам).
   */
  function subscribeAnnouncement(onCheck: () => void): () => void {
    return subscribeCommand(ANNOUNCEMENT_PULL_COMMAND, onCheck)
  }

  // ⚠ Клиент ОДИН на композабл, а подписок на нём сколько угодно. Первая редакция строила свой
  // `B24PullClientManager` в каждой подписке, и на рабочем экране, где подписаны оба канала, это
  // давало ДВА websocket-соединения к одной и той же трубе портала — различающихся только именем
  // команды. SDK умеет несколько подписок на одном клиенте, и лишнее соединение здесь ничем не
  // оправдано: это расход у клиента и у pull-сервера портала плюс лишняя площадь для гонок при
  // повторных монтированиях.
  let shared: InstanceType<typeof B24PullClientManager> | null = null
  let starting: Promise<InstanceType<typeof B24PullClientManager> | null> | null = null
  let subscribers = 0

  async function ensurePull(channel: string): Promise<InstanceType<typeof B24PullClientManager> | null> {
    if (shared) return shared
    // ⚠ Общий «в полёте» промис: две подписки заводятся в одном setup подряд, и без него они обе
    // ушли бы поднимать свой клиент — то самое удвоение, только по гонке, а не по построению.
    starting ??= (async () => {
      await init()
      const frame = get()
      if (!frame) {
        degrade('not-framed', channel)
        return null
      }
      const client = new B24PullClientManager({ b24: frame, restApplication: appModuleId() })
      await client.start()
      shared = client
      state.value = 'live'
      return client
    })().catch(() => {
      degrade('pull-failed', channel)
      return null
    }).finally(() => {
      starting = null
    })
    return starting
  }

  /** Общая машинерия подписки: канал один, команды разные. */
  function subscribeCommand(command: string, onEvent: () => void): () => void {
    let disposed = false
    let dispose: (() => void) | null = null

    const teardown = () => {
      try {
        dispose?.()
      } catch { /* ignore */ }
      dispose = null
      // ⚠ Клиент гасится только когда ушёл ПОСЛЕДНИЙ подписчик: он общий, и снос его первой же
      // размонтированной подпиской оборвал бы соседнюю.
      subscribers = Math.max(0, subscribers - 1)
      if (subscribers === 0 && shared) {
        try {
          shared.destroy?.()
        } catch { /* ignore */ }
        shared = null
      }
    }

    subscribers++
    void (async () => {
      try {
        const pull = await ensurePull(command)
        if (!pull || disposed) return
        // The SDK dispatches this callback ONLY for the subscribed command bucket —
        // it passes (params, extra, command, meta), so react unconditionally; there's no {command} arg.
        dispose = pull.subscribe({ moduleId: appModuleId(), command, callback: () => onEvent() })
        if (disposed) teardown()
      } catch {
        // pull server off / not framed → живого обновления нет; ручная перезагрузка работает.
        degrade('pull-failed', command)
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
  return { notifyReload, subscribeReload, subscribeAnnouncement, state: readonly(state), failure: readonly(failure) }
}
