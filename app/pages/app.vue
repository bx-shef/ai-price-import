<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import SettingsIcon from '@bitrix24/b24icons-vue/outline/SettingsIcon'
import WarningAlarmIcon from '@bitrix24/b24icons-vue/main/WarningAlarmIcon'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import { navigateTo } from '#app'
import { useImport } from '~/composables/useImport'
import { useMetrics } from '~/composables/useMetrics'
import { ON_MISSING_LABEL } from '~/config/onMissing'
import { useSettings } from '~/composables/useSettings'
import { useSettingsSync } from '~/composables/useSettingsSync'
import { useB24 } from '~/composables/useB24'
import { APP_SLIDER_PLACE_SETTINGS, APP_SLIDER_PLACE_METRICS, APP_SLIDER_PLACE_MAIN, APP_SLIDER_PLACE_TEST1 } from '~/config/b24'
import { isPortalConfigured } from '~/utils/portalSettings'
import { jobStatusMeta } from '~/utils/jobStatus'
import { appScreenState } from '~/utils/appScreenState'
import { appLaunchMode, canAutoOpenMain, MAIN_SLIDER_MARK_KEY, type AppLaunchMode } from '~/utils/appLaunchMode'
import { formatMinutes } from '~/utils/savings'
import { APP_NAME } from '~/config/appIdentity'

// In-portal home — ACTION-FIRST (owner decision): the upload dropzone is the hero at the top so the
// primary flow (open → drop/snap a document) is one step, on desktop and in the B24 mobile app. The
// former separate /import page is merged here; recent operations + savings sit below. Layout `clear`,
// prerendered, styled with b24ui + semantic --ui-color-* tokens (light/dark-auto).
definePageMeta({ layout: 'clear' })
// noindex: prerendered and publicly reachable, but the body is ClientOnly — a crawler would index an
// EMPTY page on the landing's domain. Same for /settings and /metrics; /install, /import, /login and
// /queues render a thin static shell and carry it too. `robots.txt` deliberately does NOT block them:
// a blocked page is never fetched, so its noindex is never read (see server/utils/seoFiles.ts).
useHead({ title: APP_NAME, meta: [{ name: 'robots', content: 'noindex' }] })

// ⚠ Ни «Очистить список», ни крестика у строки больше НЕТ (решение владельца 10.08.2026): историю
// импортов смотрят в журнале, то есть в делах портала, а лента текущей сессии живёт в памяти
// открытой страницы и умирает вместе с ней — прятать из неё отдельные строки незачем. Заодно этим
// закрыт #479: ключ ожидания мог остаться навсегда только если строку убрали из списка, а убрать её
// больше нечем.
const { jobs, loading, uploading, error, listError, listWarning, hasActive, refreshNow, upload, jobDone, startAutoPoll, stopAutoPoll } = useImport()
const { counters, savings, moneyBlocker, resetting, error: metricsError, load: loadMetrics, reset: resetMetrics } = useMetrics()

// Setup gate: the app works on defaults, but before the first import an admin should configure it
// (article field, target, chats). On load we read the portal settings; if nothing has been touched
// (pristine defaults) we nudge — an admin to open /settings, a non-admin to ask their admin. Only
// when settings actually loaded IN the portal (`settingsLoaded` — no frame → error → no nudge).
const { mapping, isAdmin, error: settingsError, load: loadSettings } = useSettings()
const settingsLoaded = ref(false)
const needsSetup = computed(() => settingsLoaded.value && !isPortalConfigured(mapping.value))

// Отметка о показе уведомления об изменении документов (#418) — best-effort, см. композабл.
// Третье состояние экрана: «ещё не знаем» (#256). Пока настройки не разрешились, показываем скелетон
// раскладки — раньше здесь рисовался весь рабочий экран, который затем схлопывался в баннер.
// Вне портала settingsLoaded так и останется false, поэтому ждём ЛЮБОГО исхода загрузки настроек.
const settingsResolved = ref(false)
// Одно правило на состояния экрана — чистое и покрыто тестом (appScreenState).
// ⚠ Экрана согласия здесь больше нет (#438): принятие условий собирает Маркет ДО установки, а
// п. 4.3.2 привязывает подтверждение к действию загрузки приложения. Подробнее — appScreenState.
const screen = computed(() => appScreenState({
  launch: launch.value,
  settingsResolved: settingsResolved.value,
  needsSetup: needsSetup.value
}))

// #360: у портала может не быть чат-бота (бесплатный тариф, предел ботов, права не выданы) — тогда
// сообщения в чат подписаны именем сотрудника, а не приложения. Раньше это было видно только
// счётчиком, который никто не открывает.
const { ready: chatBotReady, load: loadChatBotStatus } = useChatBotStatus()
// Кнопка баннера ведёт в карточку Маркета — там и переустановка, и смена тарифа. Берём готовый
// открыватель слайдера у модалки оценки: он ничего не опрашивает, пока не позовут `check()`.
const { openMarket } = useAppRating()
const warnUnsignedChat = computed(() => shouldWarnUnsignedChat({
  screen: screen.value,
  isAdmin: isAdmin.value,
  botReady: chatBotReady.value,
  notifyChatId: mapping.value.notifyChatId
}))

// Open settings in a B24 SLIDER (native overlay), like the official b24-ai-starter reference:
// `openSliderAppPage({ place })` re-opens THIS app in a slider carrying `place='app-options'`, and the
// global middleware routes that slider frame to /settings. We do NOT use `slider.openPath` — that opens
// a PORTAL-relative path (it resolved to `<portal>/settings` → 404). Fallback to in-frame navigation
// when not framed (standalone) or if the SDK call fails, so settings always opens.
const { init: initB24, placementPlace, isSliderMode, openAppSlider, auth: b24Auth } = useB24()
// Portal domain scopes the remembered import target (#349) — the only identity the frame gives the
// client (`member_id` stays server-side). Empty until init resolves; the memory key falls back then.
const portalDomain = ref('')
// Как открыто приложение (#262). `undefined` — ещё не знаем: до ответа рисуем скелетон, иначе
// базовый фрейм успел бы поднять рабочий экран со всем его опросом.
const launch = ref<AppLaunchMode | undefined>()
// While files are uploading, LOCK the rest of the UI (recent-operations list + savings/metrics) so the
// operator can't clear history / remove rows / reset metrics mid-run (owner ask «при загрузке блокируй
// списки»). `stagingBusy` comes from ImportStaging's one-by-one loop; `uploading` is a single POST in
// flight. Either → busy.
const stagingBusy = ref(false)
// Журнал импортов перечитывается, когда пачка ДОШЛА ДО КОНЦА (`busy` сменился с true на false):
// только что загруженный документ иначе не появился бы в нём до перезагрузки страницы, и два
// блока об одном и том же противоречили бы друг другу на одном экране — «Готово» сверху и пусто
// снизу. Перечитываем именно на спаде: во время пачки строки ещё не записаны, и запрос был бы
// зря потраченным обращением к порталу.
const journalRef = useTemplateRef<{ reload: () => Promise<void> }>('journalRef')
watch(stagingBusy, (now, was) => {
  if (was && !now) void journalRef.value?.reload()
})
// Закрытие предупреждения о настройке «пропустить ненайденные» — на время открытой страницы.
// Персистентного намеренно нет: см. комментарий у самого предупреждения.
const skipWarnNoticeHidden = ref(false)
const busy = computed(() => stagingBusy.value || uploading.value)
// Detect the Bitrix24 MOBILE APP via b24ui's own mechanism (useDevice → platform «bitrix-mobile», set by
// the b24ui platform plugin from the BitrixMobile UA — NOT the JS SDK). In the mobile app we hide
// desktop-only chrome (settings gear + «Подробные метрики»); hiding is a `v-if`, so it's theme-agnostic.
const { isBitrixMobile } = useDevice()
// Ширина 720 у обоих слайдеров-форм ВЫВЕДЕНА из вёрстки, а не выбрана на глаз, и держится на двух
// числах. Контент обеих страниц закапан `max-w-2xl` = 672 px, поэтому всё, что шире 672, — поля:
// 720 и прежние 900 рисуются одинаково, ничего не потеряно. Нижняя граница жёстче: 640 px — это
// брейкпоинт `sm`, а внутри слайдера медиазапросы считаются от вьюпорта фрейма. Уйдя под 640,
// ДЕСКТОПНЫЙ слайдер молча получил бы мобильную вёрстку — и с ней исчезла бы подсказка «обнулить
// счётчики может администратор» (`metrics.vue`, `hidden sm:inline-flex`), то есть единственное
// объяснение не-админу, ровно то, ради чего её завели (#411). Оставшиеся 48 px над 672 — запас на
// поля слайдера, которых мы не измеряли: сесть вплотную к 640 значит зависеть от них.
async function openSettings(): Promise<void> {
  const opened = await openAppSlider(APP_SLIDER_PLACE_SETTINGS, { width: 720, title: 'Настройки импорта' })
  if (!opened) await navigateTo('/settings')
}
// Стенд проверки слайдеров (#477). Открывается ТЕМ ЖЕ способом, что настройки и метрики: если
// открывать его иначе, он проверял бы не тот путь, ради которого собран.
// ⚠ Фолбэка на обычную навигацию тут НЕТ намеренно, в отличие от соседей. У них фолбэк нужен, чтобы
// настройки открылись всегда; здесь же неоткрывшийся слайдер — это САМО НАБЛЮДЕНИЕ, и подменять его
// переходом по маршруту значит скрыть ровно тот факт, который стенд должен показать.
async function openSliderProbe(): Promise<void> {
  await openAppSlider(APP_SLIDER_PLACE_TEST1, { width: 720, title: 'Стенд слайдеров — тест 1' })
}
// Detailed metrics — same slider pattern as settings (openSliderAppPage → middleware routes to /metrics).
async function openMetrics(): Promise<void> {
  const opened = await openAppSlider(APP_SLIDER_PLACE_METRICS, { width: 720, title: 'Метрики импорта' })
  if (!opened) await navigateTo('/metrics')
}

// Live settings sync (starter pull `reload.options`): when settings are saved in the slider (or another
// open instance), re-read them so the setup nudge reflects the new config immediately. Subscribe
// SYNCHRONOUSLY in setup — after an `await` the active effect scope is lost and onScopeDispose (inside
// the composable) would no-op, leaking the pull client. init() runs async inside; this is inert
// outside a portal.
const { subscribeReload } = useSettingsSync()
// Подписку заводим синхронно (после await теряется scope эффекта), но в пусковой странице её надо
// СНЯТЬ, а не просто заглушить обработчик: сама подписка поднимает websocket, и он висел бы вторым —
// рядом с тем, что поднимает открытый слайдер. Ровно то удвоение, ради которого лаунчер и делался.
const unsubscribeReload = subscribeReload(async () => {
  if (launch.value === 'launcher') return
  // ⚠ Тело обёрнуто в try/catch, и это не перестраховка: подписчик зовёт обработчик БЕЗ `await` и
  // без своего перехвата, а обработчик теперь async — то есть любой брошенный отсюда отказ стал бы
  // необработанным отказом промиса на каждое сохранение настроек соседом. Сегодня не стреляет лишь
  // потому, что `loadSettings` глотает свои ошибки сама; это свойство ВЫЗЫВАЕМОГО кода, а не наша
  // гарантия, и держаться на нём нельзя.
  try {
    // ⚠ Перечитываем настройки и ЖДЁМ их: раньше здесь стоял голый `void loadSettings()`, и цель по
    // умолчанию бралась бы из ещё не обновлённого `mapping` — экран показал бы прежнее значение и
    // остался бы с ним до следующего события. Тихо и правдоподобно.
    await loadSettings()
    // ⚠ ВЫБОР «Куда» СОБЫТИЕ НЕ ТРОГАЕТ (#488, решение владельца 09.08.2026): правила маршрутизации
    // админа применяются только к тем, у кого стоит «Авто» — в этом весь его смысл. Сотрудник,
    // выбравший смарт-счёт, выбрал его сознательно. Прежняя редакция сбрасывала выбор на КАЖДОЕ
    // сохранение, и у бухгалтера, весь день грузящего накладные в одно направление, он слетал от
    // правки словаря единиц в соседней вкладке.
    // ⚠ Единственная законная смена цели — маршрут перестал существовать; её делает живой каскад
    // пикера и ОБЪЯВЛЯЕТ человеку сообщением (`TargetPicker` → `invalid`).
    // ⚠ Здесь обновляется то, что зависит от настроек: баннер «сначала настройте» и содержимое,
    // читающее `mapping`. Единицы и поведение при ненайденном товаре читает сервер на момент
    // постановки задачи — в браузере их обновлять нечего.
  } catch {
    // Молча: синхронизация — удобство, а не действие, которого человек ждёт. Отказ самой загрузки
    // настроек уже отражён в состоянии экрана (`loadError`), второй раз о нём сообщать нечем.
  }
})
// ⚠ Двойное сохранение подряд даёт ДВА события и два перечитывания, и порядок ответов сети не
// гарантирован — теоретически применится более старый набор. Здесь это оставлено как есть: цена
// ошибки — одно устаревшее значение до следующего события, а склейка повторов и предел частоты
// заведены отдельной задачей (#482), потому что они про нагрузку на портал, а не про этот экран.

// Слайдер не открылся (портал отказал / SDK бросил). Тогда пусковая страница — тупик: единственная
// кнопка молча ничего не делает. Показываем это словами, а сам экран уводим в рабочий режим.
const sliderFailed = ref(false)

/** Открыть главный экран слайдером (#262). Пусковая страница делает это сама при открытии, и та же
 *  кнопка остаётся на экране — после закрытия слайдера должен быть путь обратно.
 *
 *  `closeAppSlider` тут намеренно НЕ зовём (в референсе он есть): открыть себя слайдером может
 *  только лаунчер, а лаунчер по определению не слайдер — закрывать нечего. */
async function openMain(): Promise<boolean> {
  const opened = await openAppSlider(APP_SLIDER_PLACE_MAIN, { width: 1200, title: APP_NAME })
  sliderFailed.value = !opened
  // Отметку ставим ТОЛЬКО на успехе: иначе портал, где слайдеры вообще не открываются, съедал бы ею
  // право на автооткрытие — и повторная загрузка страницы в пределах окна оставляла бы человека на
  // пусковой странице с нерабочей кнопкой и без рабочего экрана.
  if (opened) {
    try {
      window.sessionStorage?.setItem(MAIN_SLIDER_MARK_KEY, String(Date.now()))
    } catch { /* приватный режим — без отметки, страховка от цикла просто не сработает */ }
  }
  return opened
}

/** Отметка предыдущего автооткрытия в этой вкладке — страховка от бесконечного открытия. */
function lastMainSliderAt(): number | null {
  try {
    const raw = window.sessionStorage?.getItem(MAIN_SLIDER_MARK_KEY)
    return raw ? Number(raw) : null
  } catch {
    return null
  }
}

onMounted(async () => {
  const frame = await initB24()
  portalDomain.value = b24Auth()?.domain ?? '' // scopes the remembered import target (#349)
  launch.value = appLaunchMode({
    inFrame: !!frame,
    place: placementPlace(),
    sliderMode: isSliderMode(),
    isMobile: isBitrixMobile.value
  })
  if (launch.value === 'launcher') {
    // Базовый фрейм — только пусковая страница. Опрос статусов, метрики и настройки здесь НЕ
    // поднимаем: иначе они крутились бы одновременно и тут, и в открытом слайдере.
    // Автооткрытие — не чаще раза в окно (страховка от цикла); человек всегда может нажать кнопку.
    // Если окно уже открывали только что — просто показываем кнопку, ничего не поднимая.
    // ⚠ Подписка снимается ТОЛЬКО когда пусковая страница действительно остаётся пусковой. Прежде
    // её снимали ПЕРЕД попыткой открыть слайдер, и на портале, где слайдеры не открываются, экран
    // уходил в рабочий режим с навсегда мёртвым каналом: правка настроек не доезжала никогда, а
    // выглядело это как «push не работает» (разбор PR #476).
    if (!canAutoOpenMain(lastMainSliderAt(), Date.now())) {
      unsubscribeReload()
      return
    }
    if (await openMain()) {
      unsubscribeReload()
      return
    }
    // Слайдер не открылся — не оставляем человека на мёртвой странице, работаем как раньше.
    launch.value = 'work'
  }
  startAutoPoll() // initial status load + follow in-flight jobs (self-stops when all terminal)
  loadMetrics()
  void loadChatBotStatus() // фоном: баннер не должен задерживать рабочий экран
  await loadSettings()
  // Loaded successfully inside the portal (a frame error means standalone/no-auth → don't nudge).
  settingsLoaded.value = !settingsError.value
  settingsResolved.value = true // исход известен — можно показывать баннер или работу
})
onBeforeUnmount(stopAutoPoll) // don't keep polling after leaving the page
// ⚠ Подписку снимаем и в РАБОЧЕМ режиме, а не только на пусковой странице. Прежде она снималась
// исключительно внутри ветки лаунчера, и на самом частом пути её не снимал никто: фолбэк настроек
// и метрик уходит обычной навигацией (`navigateTo('/settings')`), страница размонтируется, а
// поднятый ею pull-клиент остаётся жить. Вернулся на `/app` — и рядом со старым поднимается второй.
// Ровно то удвоение, ради которого лаунчер и делался, только на пути, которым ходят каждый день.
// ⚠ Отписка идемпотентна (снятие уже снятой подписки — no-op), поэтому ветка лаунчера, снявшая её
// раньше, ничего не ломает.
onBeforeUnmount(unsubscribeReload)

// Two-step reset (no window.confirm): click «Сбросить» → confirm inline. Keep the
// confirm visible (so «Да» shows «Сброс…»/disabled) until the request resolves.
const confirmReset = ref(false)
async function doReset(): Promise<void> {
  try {
    await resetMetrics()
  } finally {
    confirmReset.value = false
  }
}

// Деньги показываем, только если админ портала задал стоимость часа (#270): валюту берём из самого
// портала и не выдумываем. Нет ставки — плитки нет, и сетка схлопывается в одну колонку, иначе
// одинокая плитка «Сэкономлено времени» висела бы на половине ширины с пустотой рядом.
const hasMoneyTile = computed(() => !!savings.value && savings.value.moneySaved !== null)
// Plain-Russian reason the money tile is absent. Silence here was the reported bug: an admin who
// had entered the hourly rate saw nothing and could not tell «не сработало» from «не хватает ещё
// одной настройки». `null` — nothing to explain (the tile is there, or nothing imported yet).
const moneyHint = computed(() => {
  if (moneyBlocker.value === 'no-rate') return 'Чтобы видеть экономию в деньгах, укажите стоимость часа работы сотрудника в настройках приложения.'
  if (moneyBlocker.value === 'no-currency') return 'Стоимость часа задана, но в портале нет базовой валюты — сумму не в чем считать. Задайте базовую валюту в настройках валют Битрикс24.'
  return ''
})
const moneySavedText = computed(() => (savings.value?.moneySaved ?? 0).toLocaleString('ru-RU'))

// Compact status counts (inline in the «Последние операции» header instead of big dashboard tiles —
// keeps the upload above the fold).
const stats = computed(() => {
  const s = { done: 0, error: 0, running: 0 }
  for (const j of jobs.value) {
    if (j.status === 'done') s.done++
    else if (j.status === 'error') s.error++
    // Only genuinely unfinished jobs count as «в работе» — `expired` is terminal, and counting it
    // here would show «в работе: N» while nothing is polling.
    else if (!jobStatusMeta(j.status).terminal) s.running++
  }
  return s
})

// Trigger the «оцените приложение» modal only after a FRESH successful import THIS session — a job we
// watched go from active → done. NOT a lifetime metric (counters.created) nor the initial history count
// (both would arm on mere page-open for a returning user, and the modal would pop with no new result to
// read). `seenActive` remembers jobIds observed non-terminal; a done job that was in it = a fresh
// completion. The show/throttle/verification decision is server-side (portal_app_rating); the modal
// delays ~10s after this flips so the result is seen first. See docs/PROJECT_MAP.md.
const seenActive = new Set<string>()
// Метрики после импорта (#444). Читались ОДИН РАЗ при открытии: человек загружал пять документов,
// видел результаты в списке — а «Обработано документов» и «Сэкономлено» оставались прежними, до
// перезагрузки страницы, которую в портале никто не делает.
// ⚠ Момент обновления — СНЯТИЕ БЛОКИРОВКИ, а не завершение каждого задания: импорт идёт пачкой, и
// на каждый файл это был бы лишний запрос. Пока `busy`, экран и так заблокирован; отпустили —
// значит пачка отработала, и числа пора пересчитать один раз.
// ⚠ Обновление МОЛЧАЛИВОЕ: индикатор не поднимается (иначе ради свежих чисел на секунду отнимаются
// уже показанные), отказ не выводится (прежние числа верны, они лишь на импорт устарели, а ошибка
// поверх успешного импорта сообщала бы о поломке, которой нет).
watch(busy, (now, was) => {
  if (was && !now) void loadMetrics({ silent: true })
})

const freshImportSuccess = ref(false)
watch(jobs, (list) => {
  for (const j of list) {
    if (!jobStatusMeta(j.status).terminal) seenActive.add(j.jobId)
    else if (j.status === 'done' && seenActive.has(j.jobId)) freshImportSuccess.value = true
  }
}, { deep: true })
</script>

<template>
  <!-- CLIENT-ONLY: this in-portal page's content depends on the B24 frame handshake (auth/placement),
       which exists only in the browser — server-prerendering it and hydrating framed produced
       "Hydration completed but contains mismatches" (and, when a slider opened /app then the middleware
       redirected, the prerendered /app header fused with the redirected page's body). ClientOnly renders
       nothing on the server → no mismatch. -->
  <ClientOnly>
    <!-- Панель каркаса (#259): навбар — в #header, контент — в #body. Родная база панели несёт
         `min-h-svh` (храповик высоты iframe: контент всегда ≥ фрейма, Битрикс24 не сможет его
         уменьшить), внутреннюю прокрутку тела и свой sm-паддинг. ⚠ `:b24ui` МЕРДЖИТСЯ через
         tailwind-merge, а не заменяет слот, поэтому каждый из них снят явным конфликтующим
         классом: `min-h-0`, `overflow-y-visible`, `gap-0`, `sm:p-0` (см. layout clear.vue). -->
    <B24DashboardPanel
      id="home"
      :b24ui="{ root: 'relative flex flex-col w-full min-w-0 min-h-0', body: 'flex flex-col gap-0 overflow-y-visible sm:p-0' }"
    >
      <template #header>
        <!-- Шапка страницы — навбар каркаса (#259) вместо самодельного flex-заголовка. В мобильном
             приложении Б24 нативная шапка УЖЕ показывает название, поэтому навбар там не рисуем. -->
        <B24DashboardNavbar
          v-if="!isBitrixMobile && screen !== 'launcher'"
          :toggle="false"
          :title="APP_NAME"
        >
          <template #right>
            <!-- ⚠ Шестерёнка блокируется на время пачки, как карточка «Экономия» (#443). Прежде
                 блокировки у неё не было ВОВСЕ: она живёт в слоте навбара каркаса, то есть вне всех
                 блоков, которые гасятся по `busy`, — и сотрудник открывал настройки прямо посреди
                 загрузки. Несимметричность была невидима: обе кнопки выглядят одинаково доступными.
                 ⚠ Настоящий `:disabled`, а НЕ `pointer-events-none`: второе блокирует только мышь,
                 кнопка остаётся в порядке обхода по Tab и срабатывает по Enter (см. карточку
                 «Экономия» ниже — там этот же приём заменён по той же причине).
                 ⚠ Подпись меняется вместе с состоянием: отключённая кнопка без объяснения читается
                 как поломка. Программе чтения объяснение нужно тем более — визуальной подсказки
                 (приглушённая карточка рядом) она не передаёт. -->
            <B24Button
              :icon="SettingsIcon"
              color="air-tertiary-no-accent"
              size="sm"
              :disabled="busy"
              :aria-label="busy ? 'Настройки импорта недоступны, пока идёт загрузка' : 'Настройки импорта'"
              @click="openSettings"
            />
          </template>
        </B24DashboardNavbar>
      </template>

      <template #body>
        <div class="mx-auto w-full max-w-2xl p-4 sm:p-6">
          <p
            v-if="screen === 'work'"
            class="mb-4 text-base text-(--ui-color-base-3)"
          >
            Загрузите или сфотографируйте накладную, счёт, КП или прайс — приложение само внесёт товары в CRM.
          </p>

          <!-- Пока исход загрузки настроек неизвестен — только скелетон раскладки (#256). -->
          <AppLoader v-if="screen === 'loading'" />

          <!-- Пусковая страница (#262): приложение открыли прямой ссылкой / пунктом меню. Рабочий
             экран здесь НЕ поднимаем — он уже открыт слайдером поверх. Кнопка нужна, чтобы был
             путь обратно после закрытия слайдера. -->
          <div
            v-else-if="screen === 'launcher'"
            class="py-6 text-center"
            role="status"
          >
            <p class="mb-4 text-base text-(--ui-color-base-3)">
              Импорт открывается отдельным окном поверх портала. Не открылось или вы его
              закрыли — нажмите «Открыть импорт».
            </p>
            <p
              v-if="sliderFailed"
              class="mb-4 text-sm text-(--ui-color-accent-main-alert)"
            >
              Окно открыть не удалось. Попробуйте ещё раз или обновите страницу.
            </p>
            <B24Button
              color="air-primary"
              label="Открыть импорт"
              @click="() => { void openMain() }"
            />
          </div>

          <!-- Setup nudge: shown until the admin configures the app (pristine defaults). Admin gets a
         call-to-action to /settings; a non-admin is told to ask their portal admin.
         Цвет и иконка — по решению владельца (#257): нейтральный air-secondary + WarningAlarmIcon;
         у кнопки цвет НЕ задаём, оставляем дефолт компонента. -->
          <B24Alert
            v-if="screen === 'setup'"
            class="mb-4"
            color="air-secondary"
            :icon="WarningAlarmIcon"
            :title="isAdmin ? 'Сначала настройте приложение' : 'Приложение ещё не настроено'"
            :description="isAdmin
              ? 'Осталось указать, куда вносить товары, по какому полю искать их в каталоге и в какой чат слать уведомления. Нажмите «Настроить» — это займёт пару минут.'
              : 'Импорт пока не запустить. Попросите администратора портала настроить приложение — после этого загрузка документов станет доступна.'"
          >
            <template
              v-if="isAdmin"
              #actions
            >
              <B24Button
                label="Настроить импорт"
                size="sm"
                @click="openSettings"
              />
            </template>
          </B24Alert>

          <!-- Бот не завёлся (#360): сообщения уходят, но подписаны сотрудником, а не приложением.
         Показываем ТОЛЬКО админу и ТОЛЬКО когда чат уведомлений реально настроен — иначе сообщений
         нет вовсе и предупреждать не о чем. Не блокирует работу: это качество подписи, не отказ. -->
          <B24Alert
            v-if="warnUnsignedChat"
            class="mb-4"
            color="air-secondary"
            size="sm"
            :icon="WarningAlarmIcon"
            title="Сообщения в чат подписаны сотрудником"
            description="Импорт работает как обычно, но отчёты и сообщения об ошибках приходят от имени сотрудника, который ставил приложение: своего чат-бота у приложения на этом портале пока нет. Обычно причина одна из двух — на тарифе портала чат-боты недоступны либо при установке не выдали право на них. В первом случае поможет коммерческий тариф, во втором — переустановка с полным набором прав."
          >
            <template #actions>
              <B24Button
                label="Открыть в Маркете"
                size="sm"
                color="air-tertiary"
                @click="openMarket"
              />
            </template>
          </B24Alert>

          <!-- Пока приложение НЕ настроено (needsSetup) показываем ТОЛЬКО баннер выше (админу — с кнопкой
           «Настроить», не-админу — «обратитесь к администратору»); весь рабочий контент скрыт до настройки
           (owner ask). Вне портала (standalone) needsSetup=false → всё видно как обычно. -->
          <template v-if="screen === 'work'">
            <!-- PRIMARY ACTION: stage files → ONE target for the batch → «Импортировать» uploads the batch
             and WAITS for every result, holding the page locked (owner rework, round 2). `upload`/`jobDone`
             come from THIS page's single useImport() so the run and the list below share one poll. -->
            <!-- Предупреждение о выбранной настройке «Пропустить строку и предупредить» (решение
             владельца 06.08.2026: поведение оставляем как есть, но человека предупреждаем ЗАРАНЕЕ).
             Что происходит без него: если ни одна позиция документа не подобралась по артикулу, при
             этой настройке пропускаются ВСЕ строки, и импорт отвечает жёсткой ошибкой — запись не
             создаётся вовсе. Для документа без колонки артикула (в РБ/РФ обычная первичка) это
             штатный исход, а выглядит как поломка, потому что узнаёт о нём человек уже ПОСЛЕ
             загрузки, из текста отказа.
             ⚠ Показываем ТОЛЬКО при явно выбранном `skip-warn`: на дефолте (`freeform`) строки
             вносятся как есть, отказа нет, и предупреждать не о чем — баннер на каждом портале
             читался бы как шум и перестал бы работать там, где нужен.
             ⚠ Это `B24Alert`, а НЕ `B24Banner`, и разница не косметическая. Первая редакция стояла
             на `B24Banner`, а он по документации b24ui — верхняя полоса страницы фиксированной
             высоты (`h-12`), и заголовок в нём `truncate`: наше предупреждение схлопывалось в ОДНУ
             строку с многоточием, и главное — «запись в CRM не создастся» — не читалось вовсе.
             `description` у `B24Banner` нет, обойти можно было только борьбой с компонентом.
             `B24Alert` разносит короткий заголовок и объяснение и переносит текст; им же сделаны
             все прочие контекстные предупреждения в проекте.
             ⚠ `role="status"`, а не `alert`: сообщение показывается по СОСТОЯНИЮ настройки, а не в
             ответ на действие, поэтому перебивать чтение не должно. Своей роли у компонента нет —
             без явной программа чтения не объявит его вовсе.
             ⚠ Закрытие — на время открытой страницы, БЕЗ запоминания. Прежняя редакция полагалась
             на встроенное «запомнить навсегда» через localStorage, и это было неверно трижды:
             хранилище общее для всех порталов (админ двух порталов закрыл бы на одном и не увидел
             на другом), отметка не снимается при возврате настройки в `skip-warn` — то есть молчала
             бы ровно тогда, когда предупреждение снова нужно, — и само поведение мы не сверяли.
             ⚠ ТЕКСТ ИСПРАВЛЕН по замечанию владельца с живого портала: он обещал, что «запись в CRM
             не создастся», и называл документ «отклонённым целиком». С #459 карточка создаётся
             ВСЕГДА, включая неудачную загрузку, — иначе у дела нет владельца, а без дела импорт не
             попадает в журнал. Прежняя формулировка отправляла админа искать в воронке отсутствие
             того, что там лежит, и умалчивала о главном следствии: пустая карточка с нулевой суммой
             остаётся у него в воронке и искажает отчёты по обороту. Заодно она врала про механику —
             пропускается СТРОКА, а не документ; отказ наступает лишь когда не нашлась ни одна. -->
            <B24Alert
              v-if="mapping.product.onMissing === 'skip-warn' && !skipWarnNoticeHidden"
              class="mb-4"
              role="status"
              color="air-primary-warning"
              :icon="WarningAlarmIcon"
              title="Документы без артикулов не попадут в CRM"
              :description="`Выбрана настройка «${ON_MISSING_LABEL['skip-warn']}». Позиция, которую не удалось найти в каталоге по артикулу, пропускается. Если не найдётся ни одна — импорт ответит ошибкой, а карточка создастся пустой, с нулевой суммой. Так и задумано; проверьте, что в ваших документах есть колонка с артикулами.`"
              close
              @update:open="skipWarnNoticeHidden = true"
            />

            <ImportStaging
              ref="stagingRef"
              :upload="upload"
              :job-done="jobDone"
              :refresh-now="refreshNow"
              :list-error="listError"
              :portal-domain="portalDomain"
              @update:busy="v => stagingBusy = v"
            />

            <B24Alert
              v-if="error"
              class="mt-3"
              color="air-primary-warning"
              :title="error"
            />

            <!-- ⚠ Шапка ЛЕНТЫ (#494). Список теперь ОДИН — журнал, — а здесь остаются только счётчики
                 текущей пачки и «Обновить»: они про то, что происходит сейчас, и в карточке журнала
                 им места нет. Показываем, лишь когда есть о чём: на свежем портале человек видит
                 дропзону и экономию, а не пустую строку со словом «готово: 0». -->
            <div
              v-if="jobs.length || uploading || listError || listWarning"
              class="mt-6 mb-2 flex flex-wrap items-center justify-between gap-2 transition-opacity"
              :class="busy ? 'opacity-60' : ''"
            >
              <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 class="text-base font-semibold">
                  Текущая загрузка
                </h2>
                <span
                  v-if="jobs.length"
                  class="flex items-center gap-2 text-xs"
                >
                  <span class="text-(--ui-color-accent-main-success)">готово: {{ stats.done }}</span>
                  <span class="text-(--ui-color-accent-main-primary)">в работе: {{ stats.running }}</span>
                  <span class="text-(--ui-color-accent-main-alert)">ошибки: {{ stats.error }}</span>
                </span>
                <span
                  v-if="hasActive"
                  class="flex items-center gap-1 text-xs text-(--ui-color-accent-main-primary)"
                  role="status"
                >
                  <span class="inline-block size-1.5 animate-pulse rounded-full bg-(--ui-color-accent-main-primary)" />
                  обновляется
                </span>
              </div>
              <div class="flex items-center gap-2">
                <B24Button
                  :icon="RefreshIcon"
                  color="air-tertiary-no-accent"
                  size="xs"
                  :loading="loading"
                  :disabled="loading"
                  :label="loading ? 'Обновляем…' : 'Обновить'"
                  @click="refreshNow"
                />
              </div>
            </div>

            <!-- ЕДИНАЯ ЛЕНТА (#458 + #494): история живёт в делах CRM, а не у нас, и идущий импорт
                 показывается ТУТ ЖЕ — той же строкой, только с индикатором вместо даты. Двух списков
                 об одном и том же больше нет: «Последние операции» устарели и слиты сюда. -->
            <ImportJournal
              ref="journalRef"
              class="mt-4"
              :live="jobs"
              :uploading="uploading"
            />

            <!-- Экономия (по макету docs/ui-spec.md §2.7): две крупные цифры в строку, справа — ссылка на
             подробные метрики и сброс; счётчики отдельной тихой строкой ПОД карточкой. -->
            <!-- ⚠ `opacity` остаётся ОФОРМЛЕНИЕМ, а блокируют настоящие `:disabled` на самих
                 кнопках (#443). Прежде замок держался на `pointer-events-none`, и это была
                 блокировка ТОЛЬКО ДЛЯ МЫШИ: кнопки внутри такого контейнера остаются в порядке
                 обхода по Tab и срабатывают по Enter — то есть посреди пачки счётчики можно было
                 обнулить с клавиатуры. `select-none` убран вместе с ним: он запрещал выделять
                 текст, что к блокировке действий отношения не имеет и мешало скопировать число. -->
            <B24Card
              variant="outline"
              class="mt-4 transition-opacity"
              :class="busy ? 'opacity-60' : ''"
            >
              <div class="flex flex-wrap items-start gap-x-8 gap-y-4">
                <!-- Плитки — B24PageGrid + B24PageCard каркаса (#259) вместо самодельных цифр. -->
                <B24PageGrid :class="hasMoneyTile ? 'flex-1 sm:grid-cols-2 lg:grid-cols-2' : 'flex-1 sm:grid-cols-1 lg:grid-cols-1'">
                  <B24PageCard
                    variant="tinted-no-accent"
                    title="Сэкономлено времени"
                    :b24ui="{ title: 'text-xs uppercase tracking-wide text-(--ui-color-base-3)' }"
                  >
                    <p class="text-[22px] leading-tight font-semibold">
                      {{ savings ? formatMinutes(savings.minutesSaved) : '—' }}
                    </p>
                  </B24PageCard>
                  <!-- Деньги показываем, только если админ задал стоимость часа: валюта берётся
                     из самого портала, выдумывать её нельзя (#270). Не задана — плитки просто нет. -->
                  <B24PageCard
                    v-if="hasMoneyTile"
                    variant="tinted-no-accent"
                    title="Сэкономлено денег (примерно)"
                    :b24ui="{ title: 'text-xs uppercase tracking-wide text-(--ui-color-base-3)' }"
                  >
                    <p class="text-[22px] leading-tight font-semibold">
                      {{ moneySavedText }} <CurrencySign :code="savings?.currency ?? undefined" />
                    </p>
                  </B24PageCard>
                  <!-- Плитки нет — говорим, чего не хватает, вместо пустого места. -->
                  <p
                    v-else-if="moneyHint"
                    class="self-center text-xs text-(--ui-color-base-3)"
                  >
                    {{ moneyHint }}
                  </p>
                </B24PageGrid>
                <div class="ml-auto flex flex-col items-end gap-2 text-xs">
                  <!-- «Подробные метрики» скрыта в мобильном приложении Б24 (b24ui useDevice) — узкий экран. -->
                  <button
                    v-if="!isBitrixMobile"
                    type="button"
                    :disabled="busy"
                    class="text-sm font-medium text-(--ui-color-accent-main-link) hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60"
                    @click="openMetrics"
                  >
                    Подробные метрики →
                  </button>
                  <!-- Сброс — только администратору (#411). Признак здесь СЕРВЕРНЫЙ (`useSettings`,
                       свой запрос за настройками всё равно идёт) — правило выбора источника см. в
                       `useSettings.ts`. ⚠ Это вторая точка входа в то же разрушительное действие:
                       первая правка закрыла её только на `/metrics`, и на самом посещаемом экране
                       сотрудник по-прежнему соглашался «Да, обнулить» и получал 403 после согласия.
                       Подсказки тут нет намеренно: карточка узкая, а объяснение живёт на странице
                       подробных метрик, куда ведёт соседняя ссылка. -->
                  <B24Button
                    v-if="isAdmin && !confirmReset"
                    label="Сбросить"
                    color="air-tertiary-no-accent"
                    size="xs"
                    :disabled="busy"
                    @click="() => { confirmReset = true }"
                  />
                  <div
                    v-else-if="isAdmin"
                    class="flex flex-wrap items-center justify-end gap-2"
                  >
                    <span class="text-(--ui-color-base-3)">Обнулить счётчики экономии? Документы в CRM останутся.</span>
                    <B24Button
                      color="air-primary-alert"
                      size="xs"
                      :loading="resetting"
                      :disabled="resetting || busy"
                      :label="resetting ? 'Сбрасываем…' : 'Да, обнулить'"
                      @click="doReset"
                    />
                    <B24Button
                      label="Отмена"
                      color="air-tertiary-no-accent"
                      size="xs"
                      @click="() => { confirmReset = false }"
                    />
                  </div>
                </div>
              </div>
              <B24Alert
                v-if="metricsError"
                class="mt-3"
                color="air-primary-warning"
                size="sm"
                :title="metricsError"
              />
            </B24Card>
            <p
              class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-(--ui-color-base-3) transition-opacity"
              :class="busy ? 'opacity-60' : ''"
            >
              <span>Документов: {{ counters.docs || 0 }}</span>
              <span>Создано в CRM: {{ counters.created || 0 }}</span>
              <span>Позиций: {{ counters.lines || 0 }}</span>
            </p>

            <!-- Маркетинг: работа на своём сервере — «по запросу», не готовая услуга с ценой (#96). -->
            <SelfHostedPromo />
          </template>

          <!-- «Оцените приложение»: всплывает после успешного импорта (когда польза очевидна). Показ/
             троттлинг/верификация — на сервере (portal_app_rating). Инертен вне портала. -->
          <AppRatingModal :trigger="freshImportSuccess" />

          <!-- Объявление издателя (#469): акция, новая возможность, плановые работы. Показывается
             ОДИН раз на сотрудника — отметка живёт в его браузере, на сервере её нет. На телефоне
             это шторка снизу, на компьютере — модальное окно. Инертно вне портала.
             ⚠ Это НЕ уведомление об изменении юридических документов: тот механизм удалён (#418),
             принятие условий собирает Маркет при перевыпуске приложения. Смешивать нельзя —
             общий канал обесценил бы обязательное сообщение рекламным. -->
          <AnnouncementDialog />

          <!-- СТЕНД ПРОВЕРКИ СЛАЙДЕРОВ (#477) — диагностический инструмент, не функция продукта.
               ⚠ Виден ВСЕМ, включая мобильное приложение, и это осознанно против соседей: шестерёнка
               настроек и «Подробные метрики» там скрыты (`!isBitrixMobile`, узкий экран), а здесь
               прятать нельзя — как ведут себя слайдеры в мобильном клиенте, мы не знаем вовсе, и это
               ровно половина смысла стенда.
               ⚠ Клиентам приложение ещё не показывали (решение владельца 09.08.2026), поэтому
               прятать не от кого; блок убирается целиком после прогона.
               ⚠ Отдельный вход, а не переиспользование `openSettings`: стенд обязан открываться тем
               же способом, каким открываются рабочие слайдеры, иначе он проверял бы не тот путь. -->
          <div class="mt-6 rounded-lg border border-dashed border-(--ui-color-base-5) p-3">
            <p class="text-xs text-(--ui-color-base-3)">
              Служебный стенд: проверка поведения слайдеров. Будет убран.
            </p>
            <B24Button
              class="mt-2"
              label="Открыть стенд слайдеров"
              color="air-tertiary-no-accent"
              size="sm"
              @click="openSliderProbe"
            />
          </div>

          <BuildFooter />
        </div>
      </template>
    </B24DashboardPanel>
  </ClientOnly>
</template>
