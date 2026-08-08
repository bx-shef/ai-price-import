<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
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
import { APP_SLIDER_PLACE_SETTINGS, APP_SLIDER_PLACE_METRICS, APP_SLIDER_PLACE_MAIN } from '~/config/b24'
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

const { jobs, loading, uploading, error, listError, listWarning, hasActive, refreshNow, upload, jobDone, startAutoPoll, stopAutoPoll, clearList, removeJob, rememberFile, fileFor } = useImport()
// Two-step clear (no window.confirm), same pattern as the metrics reset.
const confirmClear = ref(false)
function doClearList(): void {
  clearList()
  confirmClear.value = false
}
const { counters, savings, moneyBlocker, resetting, error: metricsError, load: loadMetrics, reset: resetMetrics } = useMetrics()

// Setup gate: the app works on defaults, but before the first import an admin should configure it
// (article field, target, chats). On load we read the portal settings; if nothing has been touched
// (pristine defaults) we nudge — an admin to open /settings, a non-admin to ask their admin. Only
// when settings actually loaded IN the portal (`settingsLoaded` — no frame → error → no nudge).
const { mapping, isAdmin, error: settingsError, load: loadSettings } = useSettings()
const settingsLoaded = ref(false)
const needsSetup = computed(() => settingsLoaded.value && !isPortalConfigured(mapping.value))

// Отметка о показе уведомления об изменении документов (#418) — best-effort, см. композабл.
const { markShown: markLegalNoticeShown } = useLegalNotice()
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
// Закрытие предупреждения о настройке «пропустить ненайденные» — на время открытой страницы.
// Персистентного намеренно нет: см. комментарий у самого предупреждения.
const skipWarnNoticeHidden = ref(false)
const busy = computed(() => stagingBusy.value || uploading.value)
// Detect the Bitrix24 MOBILE APP via b24ui's own mechanism (useDevice → platform «bitrix-mobile», set by
// the b24ui platform plugin from the BitrixMobile UA — NOT the JS SDK). In the mobile app we hide
// desktop-only chrome (settings gear + «Подробные метрики»); hiding is a `v-if`, so it's theme-agnostic.
const { isBitrixMobile } = useDevice()
async function openSettings(): Promise<void> {
  const opened = await openAppSlider(APP_SLIDER_PLACE_SETTINGS, { width: 900, title: 'Настройки импорта' })
  if (!opened) await navigateTo('/settings')
}
// Detailed metrics — same slider pattern as settings (openSliderAppPage → middleware routes to /metrics).
async function openMetrics(): Promise<void> {
  const opened = await openAppSlider(APP_SLIDER_PLACE_METRICS, { width: 900, title: 'Метрики импорта' })
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
const unsubscribeReload = subscribeReload(() => {
  if (launch.value === 'launcher') return
  void loadSettings()
})

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
    unsubscribeReload()
    // Автооткрытие — не чаще раза в окно (страховка от цикла); человек всегда может нажать кнопку.
    // Если окно уже открывали только что — просто показываем кнопку, ничего не поднимая.
    if (!canAutoOpenMain(lastMainSliderAt(), Date.now())) return
    if (await openMain()) return
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
            <B24Button
              :icon="SettingsIcon"
              color="air-tertiary-no-accent"
              size="sm"
              aria-label="Настройки импорта"
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

          <!-- Уведомление об изменении документов (#418, п. 9.3.3). Стоит ВЫШЕ баннера настройки и
               показывается независимо от него: это обязанность уведомить, а не часть рабочего
               потока. Портал, застрявший на «ещё не настроено», обязан узнать о новой редакции
               ровно так же, как работающий. Показ отмечается на сервере — п. 9.3.4 датирует
               доставку по наиболее ранней из двух дат (баннер / сообщение в чат).
               ⚠ Но НЕ в `loading` и не на пусковой странице: там баннер лёг бы поверх скелетона
               либо на экран, который человек не читает, а сервер записал бы отметку о доставке.
               Отметка — доказательство против самого лицензиата, и ставить её за показ, которого
               по существу не было, нельзя.
               ⚠ Условие написано ЧЕРЕЗ ИСКЛЮЧЕНИЯ, а не перечислением подходящих состояний:
               пятое состояние, если оно появится, обязано баннер ПОКАЗЫВАТЬ — обязанность
               уведомить общая, и молча выпасть из показа она не должна. -->
          <LegalChangeBanner
            v-if="screen !== 'loading' && screen !== 'launcher'"
            :on-shown="markLegalNoticeShown"
          />

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
             бы ровно тогда, когда предупреждение снова нужно, — и само поведение мы не сверяли. -->
            <B24Alert
              v-if="mapping.product.onMissing === 'skip-warn' && !skipWarnNoticeHidden"
              class="mb-4"
              role="status"
              color="air-primary-warning"
              :icon="WarningAlarmIcon"
              title="Документы без артикулов будут отклонены целиком"
              :description="`Выбрана настройка «${ON_MISSING_LABEL['skip-warn']}». Если ни одна позиция документа не найдётся в каталоге по артикулу, запись в CRM не создастся — импорт ответит ошибкой. Так и задумано; проверьте, что в ваших документах есть колонка с артикулами.`"
              close
              @update:open="skipWarnNoticeHidden = true"
            />

            <ImportStaging
              :upload="upload"
              :job-done="jobDone"
              :refresh-now="refreshNow"
              :list-error="listError"
              :remember-file="rememberFile"
              :portal-domain="portalDomain"
              @update:busy="v => stagingBusy = v"
            />

            <B24Alert
              v-if="error"
              class="mt-3"
              color="air-primary-warning"
              :title="error"
            />

            <!-- STATUS: recent operations with compact inline counts. Shown only once there's history to show
           (or a file is uploading) — a brand-new operator on first open sees just the dropzone + savings,
           not an empty «Последние операции» block. -->
            <div
              v-if="jobs.length || uploading || listError || listWarning"
              class="mt-6 mb-2 flex flex-wrap items-center justify-between gap-2 transition-opacity"
              :class="busy ? 'pointer-events-none opacity-60 select-none' : ''"
            >
              <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 class="text-base font-semibold">
                  Последние операции
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
                <template v-if="jobs.length && !confirmClear">
                  <B24Button
                    label="Очистить список"
                    color="air-tertiary-no-accent"
                    size="xs"
                    @click="() => { confirmClear = true }"
                  />
                </template>
                <template v-else-if="confirmClear">
                  <span class="text-xs text-(--ui-color-base-3)">Убрать завершённые строки из списка? Ещё обрабатываемые останутся, документы в CRM — тоже.</span>
                  <B24Button
                    label="Да, очистить"
                    color="air-primary-alert"
                    size="xs"
                    @click="doClearList"
                  />
                  <B24Button
                    label="Отмена"
                    color="air-tertiary-no-accent"
                    size="xs"
                    @click="() => { confirmClear = false }"
                  />
                </template>
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

            <!-- НЕ блокируется на время прогона: результаты обязаны читаться по ходу импорта — ради
               этого страница и ждёт. Блокировка остаётся на настройках/метриках ниже. -->
            <B24Card
              v-if="jobs.length || uploading || listError || listWarning"
              variant="outline"
              class="transition-opacity"
              :b24ui="{ body: 'p-0 sm:p-0' }"
            >
              <ul class="divide-y divide-(--ui-color-base-5)">
                <!-- Immediate feedback while the POST is in flight, before the job row appears. -->
                <li
                  v-if="uploading"
                  class="flex items-center gap-2 p-3 text-sm text-(--ui-color-base-3)"
                >
                  <span class="inline-block size-2 shrink-0 animate-pulse rounded-full bg-(--ui-color-accent-main-primary)" />
                  Отправляем файл…
                </li>
                <ImportJobItem
                  v-for="job in jobs"
                  :key="job.jobId"
                  :job="job"
                  :file="fileFor(job.jobId)"
                  @remove="removeJob"
                />
                <!-- Сервер ответил, но не по всем заданиям (#260): не ошибка — предупреждение, поэтому
                 показываем и при непустом списке. -->
                <li
                  v-if="listWarning"
                  class="p-3 text-sm text-(--ui-color-base-3)"
                >
                  {{ listWarning }}
                </li>
                <!-- Пустое состояние с причиной: «историю не удалось получить» и «истории нет» больше не
                 выглядят одинаково (#268). Кнопка «Обновить» в шапке блока теперь тоже видна. -->
                <li
                  v-if="!jobs.length && !uploading && listError"
                  class="p-3 text-sm text-(--ui-color-base-3)"
                >
                  Статус загрузок получить не удалось. Нажмите «Обновить» — если не поможет, закройте и
                  откройте приложение заново.
                </li>
              </ul>
            </B24Card>

            <!-- Журнал импортов (#458): история живёт в делах CRM, а не у нас. Стоит ПОД списком
                 текущей пачки и НАД экономией: сначала «что происходит сейчас», потом «что было»,
                 и только потом сводные числа. -->
            <ImportJournal class="mt-4" />

            <!-- Экономия (по макету docs/ui-spec.md §2.7): две крупные цифры в строку, справа — ссылка на
             подробные метрики и сброс; счётчики отдельной тихой строкой ПОД карточкой. -->
            <B24Card
              variant="outline"
              class="mt-4 transition-opacity"
              :class="busy ? 'pointer-events-none opacity-60 select-none' : ''"
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
                    class="text-sm font-medium text-(--ui-color-accent-main-link) hover:underline"
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
                      :disabled="resetting"
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
              :class="busy ? 'pointer-events-none opacity-60 select-none' : ''"
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

          <BuildFooter />
        </div>
      </template>
    </B24DashboardPanel>
  </ClientOnly>
</template>
