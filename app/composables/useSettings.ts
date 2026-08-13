import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders, fetchErrorMessage, frameAuthMessage } from '~/utils/frameHeaders'
import { defaultMapping } from '~/utils/portalSettings'
import { createSingleFlight } from '~/utils/loadCoalesce'
import type { PortalMapping } from '~/types/mapping'

// In-portal settings client: load/save the portal mapping via the frame-token authenticated
// /api/settings (GET/POST). Inert outside a portal (no frame auth). Saving is EXPLICIT (the settings
// form has Save/Cancel — no autosave). The `sentJson` snapshot exists only to guard against a lost
// update: if the user edits DURING a save round-trip, the server's normalized response is not reseeded
// over the newer edit.

export function useSettings() {
  const { init, ensureAuth, inFrame } = useB24()
  const mapping = ref<PortalMapping>(defaultMapping())
  const loading = ref(false)
  const saving = ref(false)
  const saved = ref(false)
  const error = ref('')
  /**
   * Ошибка ИМЕННО первой загрузки (#408).
   *
   * ⚠ Отдельная от общей `error`, и это не педантизм: `error` пишут и `load`, и `save`. Состояние
   * экрана строится на ней, поэтому неудачное СОХРАНЕНИЕ уносило бы всю форму вместе с
   * несохранёнными правками администратора — и на её месте появлялось бы «Не удалось загрузить
   * данные», то есть ложь о причине. Восстановление было бы только перезагрузкой, то есть потерей
   * введённого. Ровно это и запрещает комментарий в `settings.vue`: форму на ошибке сохранения
   * держим открытой, чтобы можно было повторить.
   */
  const loadError = ref('')
  // Whether the CALLING portal user is an admin (from GET /api/settings, verified server-side).
  // Non-admins may view settings but not save — writes are also enforced admin-only on the server.
  //
  // ⚠ Источников признака в проекте ДВА, и это осознанно (#411): здесь — из ответа сервера, потому
  // что запрос за настройками всё равно идёт и признак едет попутно, проверенным; на `/metrics` —
  // из фрейм-SDK (`useB24().isAdmin`), потому что там своего запроса нет и заводить серверный крюк
  // ради одного флага незачем. Оба — только для показа: разрешает действие в обоих случаях сервер.
  // Правило простое: есть свой серверный запрос — берите признак оттуда, нет — из фрейма.
  const isAdmin = ref(false)
  // Portal base currency (crm.currency.list BASE:'Y'), or `null` when the portal has none.
  // It labels the hourly rate — and its absence is exactly why the money tile can never appear.
  const baseCurrency = ref<string | null>(null)
  // True when the currency READ failed (as opposed to «портал не завёл базовую валюту»). The two
  // must stay apart: the UI states the second as a fact and sends the admin to fix it.
  const currencyUnknown = ref(false)
  // Flips once after the first load attempt. `loading` starts false, so a condition built on it
  // alone is true during the SDK handshake — long enough to flash a red «нет валюты» warning
  // before anything is known.
  const loaded = ref(false)
  const snapshot = (): string => JSON.stringify(mapping.value)

  /**
   * Склейка одновременных загрузок (#480).
   *
   * ⚠ Заводится ВНУТРИ композабла, а не в модуле: у каждого экрана своё состояние, и общий на
   * приложение полёт склеил бы загрузки разных экранов, отдав одному чужой ответ.
   */
  const flight = createSingleFlight()

  async function headers(): Promise<Record<string, string> | null> {
    await init()
    return buildFrameHeaders(await ensureAuth())
  }

  /**
   * Прочитать настройки с сервера.
   *
   * ⚠ Одновременные вызовы СКЛЕИВАЮТСЯ, и по завершении делается один хвостовой повтор (#480).
   * Хвост несущий: запрос, начатый ДО сохранения, вернёт настройки ДО сохранения, и присоединить к
   * нему пришедшего ПОСЛЕ значило бы отдать заведомо устаревший ответ. Ни веер, ни эта гонка не
   * видны на одной вкладке — рассылка будит все открытые экраны портала разом.
   */
  async function load(): Promise<void> {
    return flight.run(loadOnce)
  }

  async function loadOnce(): Promise<void> {
    const h = await headers()
    if (!h) {
      // ⚠ Попытка ЗАВЕРШИЛАСЬ, пусть и ничем — `loaded` обязан стать true, иначе экран остаётся в
      // скелетоне НАВСЕГДА у сотрудника ВНУТРИ портала, чья фрейм-авторизация истекла и не
      // обновилась. `inert` там false, и без этой строки не было бы ни данных, ни объяснения.
      loaded.value = true
      error.value = frameAuthMessage(inFrame(), 'Настройки доступны')
      loadError.value = error.value
      return
    }
    loading.value = true
    try {
      const res = await $fetch<{ mapping: PortalMapping, admin?: boolean, baseCurrency?: string | null, currencyUnknown?: boolean }>('/api/settings', { headers: h })
      mapping.value = res.mapping
      isAdmin.value = res.admin === true
      baseCurrency.value = typeof res.baseCurrency === 'string' ? res.baseCurrency : null
      currencyUnknown.value = res.currencyUnknown === true
      saved.value = false
      error.value = ''
      loadError.value = ''
    } catch (e) {
      error.value = fetchErrorMessage(e, 'Не удалось загрузить настройки')
      loadError.value = error.value
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  async function save(): Promise<void> {
    const h = await headers()
    if (!h) {
      error.value = frameAuthMessage(inFrame(), 'Настройки доступны')
      return
    }
    if (!isAdmin.value) {
      // The server enforces this too (403); block client-side so we don't spam a doomed POST.
      error.value = 'Сохранять настройки может только администратор портала'
      return
    }
    if (saving.value) return // guard a double Save (the button is also disabled while saving)
    // Snapshot what we're about to send BEFORE the await, so we can tell whether the user edited
    // during the round-trip.
    const sentJson = snapshot()
    saving.value = true
    saved.value = false
    try {
      const res = await $fetch<{ mapping: PortalMapping }>('/api/settings', { method: 'POST', headers: h, body: { mapping: mapping.value } })
      if (snapshot() === sentJson) {
        // Untouched since we sent it → safe to reflect the server's normalized form.
        mapping.value = res.mapping
      } else {
        // The user edited during the round-trip. Do NOT reseed (that would clobber the newer edit);
        // we persisted `sentJson`, the newer content stays for the next explicit Save.
      }
      saved.value = true
      error.value = ''
    } catch (e) {
      error.value = fetchErrorMessage(e, 'Не удалось сохранить настройки')
    } finally {
      saving.value = false
    }
  }

  return { mapping, loading, saving, saved, error, loadError, isAdmin, baseCurrency, currencyUnknown, loaded, load, save }
}
