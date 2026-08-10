<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import SearchIcon from '@bitrix24/b24icons-vue/outline/SearchIcon'
import { useAuth } from '~/composables/useAuth'
import { ALL_QUEUES, FLASH_MS, QUEUES_REFRESH_MS, QUEUE_HEALTH_STALE_MS, backlogHours, formatClock, lifetimeSummary, staleAfter, visiblePortals, type PortalHealthFilter } from '~/utils/opsMonitor'
import { copyToClipboard } from '~/utils/clipboard'
import { APP_NAME } from '~/config/appIdentity'

// Operator queue monitor (service zone). Auth-gated (server 401 + client redirect).
// Layout `clear`, noindex, prerendered (shell; data loads client-side).
definePageMeta({ layout: 'clear' })
// Заголовок вкладки называет ПРОДУКТ (#318 п.1): у владельца открыто несколько служебных консолей
// разных продуктов, и по вкладке «Служебная консоль» они неразличимы.
useHead({ title: `Служебная консоль / ${APP_NAME}`, meta: [{ name: 'robots', content: 'noindex' }] })

interface QueueCounts { name: string, waiting: number, active: number, completed: number, failed: number, delayed: number }
interface QueueAlert { kind: 'stalled' | 'failing' | 'unreadable', queue: string, text: string }
// `portal` — необратимый отпечаток портала (#498). Без него «сорок отказов подряд» нельзя было
// связать с конкретным клиентом, и ручной разбор упирался в отдельную раскопку по логам.
interface FailedJob { queue: string, id: string, reason: string, failedAt: number | null, attempts: number, portal?: string }
interface PortalStatus { memberId: string, domain: string, ageDays: number, expiresInDays: number, health: 'ok' | 'near-expiry' | 'stale' }
type RatingState = 'reviewed' | 'opened' | 'prompted' | 'none'
interface RatingStatus { memberId: string, domain: string, state: RatingState, promptedAtMs: number | null, openedAtMs: number | null }

const { authenticated, check, logout } = useAuth()
const router = useRouter()
const queues = ref<QueueCounts[]>([])
const portals = ref<PortalStatus[]>([])
const ratings = ref<RatingStatus[]>([])
const error = ref('')
// Объём обработки по всем порталам (#271-C) — в отличие от счётчиков очереди, не упирается в потолок
// хранения. Только суммы, без разбивки. `totalsFailed` отличает «база недоступна» от «пока пусто».
const totals = ref<Record<string, number> | null>(null)
const totalsFailed = ref(false)

// Здоровье очередей (BACKLOG.md §1). Глубина — это снимок: 200 ждущих одинаково выглядят и когда
// навалило работы, и когда всё встало. Сервер сравнивает два последовательных замера и говорит,
// какой из двух случаев на самом деле. `alertsCheckedAt` = null означает «ещё ни разу не смотрели»,
// и это НЕ то же самое, что «всё хорошо» — экран обязан их различать.
const alerts = ref<QueueAlert[]>([])
const alertsCheckedAt = ref<number | null>(null)

const ALERT_TITLES: Record<QueueAlert['kind'], string> = {
  stalled: 'Очередь не разгребается',
  failing: 'Задачи падают',
  unreadable: 'Состояние очереди неизвестно'
}
// Эпизод конвейера несёт служебное имя `ALL_QUEUES`; печатать его буквально нельзя — «— *» на
// экране читается как поломка самого экрана. Имена очередей в этом случае живут в тексте тревоги.
const alertTitle = (a: QueueAlert) => a.queue === ALL_QUEUES ? ALERT_TITLES[a.kind] : `${ALERT_TITLES[a.kind]} — ${a.queue}`

// Возраст проверки — не украшение. Проверка, отработавшая шесть часов назад, ничего не говорит о
// «сейчас», и рисовать её так же, как свежую, — та же ложь, что показывать непрочитанную очередь
// здоровой. Поэтому у отсутствия тревог три разных смысла, и экран их различает.
const healthNote = computed(() => {
  if (loading.value || error.value) return ''
  if (alertsCheckedAt.value === null) {
    return 'Проверка здоровья очередей ещё не отработала — это не значит, что всё в порядке.'
  }
  if (staleAfter(alertsCheckedAt.value, nowMs.value, QUEUE_HEALTH_STALE_MS)) {
    return `Последняя проверка здоровья очередей — в ${formatClock(alertsCheckedAt.value)}, данные устарели.`
  }
  return ''
})
const lifetimeText = computed(() => lifetimeSummary(totals.value
  ? { docs: totals.value.docs ?? 0, created: totals.value.created ?? 0, lines: totals.value.lines ?? 0, errors: totals.value.errors ?? 0 }
  : null))
// Поиск по порталам (#271-J): и по домену, и по member_id — у оператора на руках бывает именно id.
// Отдельно отбор по состоянию: сортировки «сломанные наверх» мало, когда порталов много, а в домен
// состояние не впишешь, поэтому текстовым поиском его не найти.
const portalQuery = ref('')
const healthFilter = ref<PortalHealthFilter>('all')
const shownPortals = computed(() => visiblePortals(portals.value, portalQuery.value, healthFilter.value))
const problemCount = computed(() => portals.value.filter(p => p.health !== 'ok').length)
/** Отбор активен — значит «показано N из M» несёт смысл; без него это просто «5 из 5». */
const portalsFiltered = computed(() => !!portalQuery.value.trim() || healthFilter.value !== 'all')
// У КАЖДОГО блока своя ошибка (#271-E). Раньше два из трёх запросов падали в `catch {}`, блок просто
// не отрисовывался, и оператор не отличал «порталов нет» от «запрос упал». На служебном экране
// молчание опаснее лишнего сообщения.
const portalsError = ref('')
const ratingsError = ref('')
// Список упавших задач (#271-B). Раньше число «ошибки: N» было тупиком: ни причины, ни времени, ни
// возможности повторить — а это первое, ради чего консоль открывают. Грузим по требованию: на
// свежем стенде ошибок нет, и лишний запрос каждые 12 секунд ни к чему.
const failedOpen = ref('')
const failedJobs = ref<FailedJob[]>([])
const failedError = ref('')
const failedLoading = ref(false)
const failedBusy = ref('')
const failedUnavailable = ref<string[]>([])
const failedLimit = ref(0)
// «Отбросить» стирает задачу из очереди насовсем — откатить нельзя вообще. Для куда более мягкого
// «Отзыв оставлен» подтверждение уже есть; здесь оно тем более обязательно.
const confirmDiscard = ref('')
/** Ключ занятости — очередь + идентификатор: id уникален внутри очереди, а не глобально. */
const busyKey = (j: FailedJob) => `${j.queue}|${j.id}`
const loading = ref(false)
// Когда данные последний раз обновлялись (#271-A). Без этой отметки замороженный снимок неотличим
// от живого.
const updatedAt = ref<number | null>(null)
const autoRefresh = ref(true)
// Тикает раз в секунду, чтобы «данные устарели» появлялось само, без нового запроса.
const nowMs = ref(Date.now())
const stale = computed(() => staleAfter(updatedAt.value, nowMs.value))

const LABELS: Record<string, string> = {
  'b24-events': 'События B24',
  'file-extract': 'Извлечение текста',
  'agent-run': 'AI-разбор',
  'crm-sync': 'Запись в CRM'
}
// Non-secret auth health (#132) — the token itself is never sent here.
const HEALTH_META: Record<PortalStatus['health'], { label: string, cls: string }> = {
  'ok': { label: 'активен', cls: 'text-(--ui-color-accent-main-success)' },
  'near-expiry': { label: 'скоро истекает', cls: 'text-(--ui-color-accent-main-warning)' },
  'stale': { label: 'нужна переустановка', cls: 'text-(--ui-color-accent-main-alert)' }
}
// «Оцените приложение» lifecycle per portal — the owner manages it here instead of running SQL.
const RATING_META: Record<RatingState, { label: string, cls: string }> = {
  opened: { label: 'открыл Маркет — проверьте отзыв', cls: 'text-(--ui-color-accent-main-warning)' },
  prompted: { label: 'показан, Маркет не открыл', cls: 'text-(--ui-color-base-3)' },
  none: { label: 'ещё не показывался', cls: 'text-(--ui-color-base-4)' },
  reviewed: { label: 'отзыв подтверждён', cls: 'text-(--ui-color-accent-main-success)' }
}
function fmtDate(ms: number | null): string {
  return ms ? new Date(ms).toLocaleDateString('ru-RU') : '—'
}

// Токен последовательности: ручное «Обновить», действие оператора и автоцикл могут наложиться, и
// ответ более СТАРОГО вызова записался бы поверх свежего. Пишем только результат последнего.
let loadSeq = 0
async function load() {
  const my = ++loadSeq
  loading.value = true
  let queuesOk = false
  try {
    const r = await $fetch<{ queues: QueueCounts[], totals: Record<string, number> | null, totalsFailed?: boolean, alerts?: QueueAlert[], alertsCheckedAt?: number | null }>('/api/ops/queues')
    if (my !== loadSeq) return
    queues.value = r.queues
    totals.value = r.totals ?? null
    totalsFailed.value = r.totalsFailed === true
    alerts.value = r.alerts ?? []
    alertsCheckedAt.value = r.alertsCheckedAt ?? null
    error.value = ''
    queuesOk = true
  } catch (e) {
    // Cookie expired while the page was open → back to sign-in.
    if ((e as { statusCode?: number })?.statusCode === 401) {
      await router.push('/login')
      return
    }
    if (my === loadSeq) error.value = 'Сервис недоступен'
  }
  // Portal auth status — best-effort для очередей (их вид не должен зависеть от этого запроса), но
  // СВОЮ ошибку блок теперь показывает.
  try {
    const t = await $fetch<{ portals: PortalStatus[] }>('/api/ops/tokens')
    if (my !== loadSeq) return
    portals.value = t.portals
    portalsError.value = ''
  } catch (e) {
    if (my !== loadSeq) return
    // 401 здесь означает то же, что и на очередях: сессия истекла. Раньше любой статус схлопывался
    // в «не удалось», и вкладка продолжала долбить эндпоинт каждые 12 секунд с неверной причиной.
    if ((e as { statusCode?: number })?.statusCode === 401) {
      await router.push('/login')
      return
    }
    portalsError.value = 'Не удалось получить состояние порталов'
  }
  // App-rating state — тоже отдельный блок со своей ошибкой.
  try {
    const a = await $fetch<{ portals: RatingStatus[] }>('/api/ops/app-rating')
    if (my !== loadSeq) return
    ratings.value = a.portals
    ratingsError.value = ''
  } catch (e) {
    if (my !== loadSeq) return
    if ((e as { statusCode?: number })?.statusCode === 401) {
      await router.push('/login')
      return
    }
    ratingsError.value = 'Не удалось получить оценки приложения'
  }
  if (my !== loadSeq) return
  loading.value = false
  // Штампуем время УСПЕХА, а не факт попытки. Иначе при молча отвалившихся запросах экран
  // показывал бы свежую отметку над старыми цифрами — ровно тот случай, ради которого признак
  // «данные устарели» и заводился.
  if (queuesOk) updatedAt.value = Date.now()
}

// Автообновление (#271-A). Экран открывают, чтобы СМОТРЕТЬ за очередями, а данные грузились один раз
// на монтировании — оператор видел замороженный снимок и не мог понять, что тот устарел. Пауза нужна,
// чтобы спокойно читать список, пока он не перестраивается под руками.
let timer: ReturnType<typeof setInterval> | null = null
let clock: ReturnType<typeof setInterval> | null = null
function stopAuto(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (clock) {
    clearInterval(clock)
    clock = null
  }
}
function startAuto(): void {
  stopAuto()
  if (typeof window === 'undefined') return
  timer = setInterval(() => {
    // Скрытая вкладка не опрашивается: консоль, оставленная открытой на ночь, иначе даёт
    // ~300 лишних запросов в час без единого зрителя.
    const hidden = typeof document !== 'undefined' && document.hidden
    if (autoRefresh.value && !loading.value && !hidden) void load()
  }, QUEUES_REFRESH_MS)
  clock = setInterval(() => {
    nowMs.value = Date.now()
  }, 1_000)
}
onBeforeUnmount(() => {
  stopAuto()
  // Иначе таймер переживёт компонент и через FLASH_MS напишет в ref размонтированной страницы.
  for (const t of flashTimers.values()) clearTimeout(t)
  flashTimers.clear()
})

// Owner control of the review lifecycle from the UI (no SQL): confirm a review (terminal) or reset
// the flag so the modal shows again.
const ratingBusy = ref<string>('') // member_id currently mutating (disables ITS buttons only)
const ratingMsg = ref<string>('')
// «Отзыв оставлен» — необратимо: состояние терминальное, кнопки сброса у него уже нет, откат только
// через SQL. Двухшаговое подтверждение у нас принятый паттерн на куда более безобидных действиях
// («Очистить список», «Обнулить счётчики») — здесь его не было (#271-I).
const confirmReviewed = ref<string>('')
const confirmUnreview = ref<string>('') // #318 п.2: отмена подтверждённого отзыва — тоже в два шага
async function setRating(memberId: string, action: 'reviewed' | 'reset' | 'unreview') {
  ratingBusy.value = memberId
  ratingMsg.value = ''
  confirmReviewed.value = ''
  confirmUnreview.value = ''
  try {
    await $fetch('/api/ops/app-rating', { method: 'POST', body: { memberId, action } })
    flash(ratingMsg, action === 'reviewed'
      ? 'Отмечено как «отзыв оставлен»'
      : action === 'unreview'
        ? 'Отметка снята. Чтобы попап показался снова, нажмите «Сбросить»'
        : 'Флаг сброшен — попап покажется снова')
    await load() // re-pull so the row reflects the new state
  } catch (e) {
    const code = (e as { statusCode?: number })?.statusCode
    if (code === 401) {
      await router.push('/login')
      return
    }
    flash(ratingMsg, 'Не удалось изменить статус')
  } finally {
    ratingBusy.value = ''
  }
}

// Force-refresh one portal's OAuth token from the UI (#132) — no SSH, no secret in the browser.
const reauthing = ref<string>('') // member_id currently refreshing (disables its button)
const reauthMsg = ref<string>('')
async function reauth(memberId: string) {
  reauthing.value = memberId
  reauthMsg.value = ''
  try {
    await $fetch('/api/ops/tokens/refresh', { method: 'POST', body: { memberId } })
    flash(reauthMsg, 'Токен обновлён')
    await load() // re-pull status so the row's expiry resets
  } catch (e) {
    const code = (e as { statusCode?: number })?.statusCode
    if (code === 401) {
      // Session expired mid-page — same handling as load(), not a fake «failed».
      await router.push('/login')
      return
    }
    flash(reauthMsg, code === 409 ? 'Портал не установлен' : code === 503 ? 'OAuth не настроен' : 'Не удалось обновить')
  } finally {
    reauthing.value = ''
  }
}

/** Показать сообщение и погасить его само (#271-G). Раньше строка результата висела на экране до
 *  перезагрузки и выглядела относящейся к любой строке списка. */
const flashTimers = new Map<Ref<string>, ReturnType<typeof setTimeout>>()
function flash(target: Ref<string>, text: string): void {
  target.value = text
  const prev = flashTimers.get(target)
  if (prev) clearTimeout(prev)
  flashTimers.set(target, setTimeout(() => {
    target.value = ''
  }, FLASH_MS))
}

// Копирование member_id (#271-K). Подтверждение живёт в самой строке и гаснет само — общая строка
// «скопировано» на весь список выглядела бы относящейся к любому порталу (та же ошибка, что #271-G).
const copiedMember = ref('')
const copyFailed = ref('')
async function copyMemberId(memberId: string): Promise<void> {
  // Молчаливый отказ недопустим: без защищённого соединения или при запрете доступа к буферу клик
  // просто ничего не делал, и оператор уходил с уверенностью, что id у него скопирован.
  if (await copyToClipboard(memberId)) flash(copiedMember, memberId)
  else flash(copyFailed, memberId)
}

/** Сбросить оба отбора — иначе из пустого списка нет выхода, кроме как стереть запрос вручную. */
function resetPortalFilters(): void {
  portalQuery.value = ''
  healthFilter.value = 'all'
}

/** Раскрыть/свернуть список ошибок конкретной очереди и подтянуть его. */
async function toggleFailed(queue: string): Promise<void> {
  if (failedOpen.value === queue) {
    failedOpen.value = ''
    return
  }
  failedOpen.value = queue
  failedLoading.value = true
  failedError.value = ''
  try {
    const r = await $fetch<{ jobs: FailedJob[], unavailable?: string[], perQueueLimit?: number }>('/api/ops/failed')
    failedJobs.value = r.jobs
    failedUnavailable.value = r.unavailable ?? []
    failedLimit.value = r.perQueueLimit ?? 0
  } catch (e) {
    if ((e as { statusCode?: number })?.statusCode === 401) {
      await router.push('/login')
      return
    }
    failedError.value = 'Не удалось получить список ошибок'
  } finally {
    failedLoading.value = false
  }
}

/** «Повторить» ставит задачу обратно в очередь, «Отбросить» убирает совсем. */
async function actOnFailed(job: FailedJob, action: 'retry' | 'discard'): Promise<void> {
  failedBusy.value = busyKey(job)
  confirmDiscard.value = ''
  try {
    const r = await $fetch<{ ok: boolean, reason?: string }>('/api/ops/failed', {
      method: 'POST',
      body: { queue: job.queue, id: job.id, action }
    })
    flash(failedMsg, r.ok
      ? (action === 'retry' ? 'Задача снова в очереди' : 'Задача отброшена')
      : 'Задачи уже нет — список обновлён')
    failedJobs.value = failedJobs.value.filter(j => !(j.queue === job.queue && j.id === job.id))
    await load() // счётчик «ошибки» на карточке должен сойтись со списком
  } catch (e) {
    if ((e as { statusCode?: number })?.statusCode === 401) {
      await router.push('/login')
      return
    }
    flash(failedMsg, 'Не удалось выполнить действие')
  } finally {
    failedBusy.value = ''
  }
}
const failedMsg = ref('')
/** Упавшие задачи только этой очереди — список приходит сразу по всем. */
function failedFor(queue: string): FailedJob[] {
  return failedJobs.value.filter(j => j.queue === queue)
}

async function signOut() {
  await logout()
  await router.push('/login')
}

onMounted(async () => {
  await check()
  if (!authenticated.value) {
    await router.push('/login')
    return
  }
  await load()
  startAuto()
})
</script>

<template>
  <div class="mx-auto max-w-3xl p-4 sm:p-6">
    <div class="mb-5 flex items-center justify-between">
      <h1 class="text-xl font-semibold">
        Служебная консоль
      </h1>
      <div class="flex items-center gap-2">
        <!-- Отметка времени + пауза автообновления (#271-A): без них замороженный снимок неотличим
             от живого, а читать список, который перестраивается под руками, невозможно. -->
        <span
          v-if="updatedAt"
          class="text-xs"
          :class="stale ? 'text-(--ui-color-accent-main-warning)' : 'text-(--ui-color-base-4)'"
          aria-live="off"
        >{{ stale ? `данные устарели, последнее обновление в ${formatClock(updatedAt)}` : `обновлено в ${formatClock(updatedAt)}` }}</span>
        <B24Button
          :label="autoRefresh ? 'Пауза' : 'Автообновление'"
          color="air-tertiary-no-accent"
          size="sm"
          :aria-label="autoRefresh ? 'Приостановить автообновление' : 'Включить автообновление'"
          @click="() => { autoRefresh = !autoRefresh }"
        />
        <B24Button
          :icon="RefreshIcon"
          color="air-tertiary-no-accent"
          size="sm"
          :loading="loading"
          :disabled="loading"
          :label="loading ? 'Обновление…' : 'Обновить'"
          @click="load"
        />
        <B24Button
          label="Выйти"
          color="air-tertiary-no-accent"
          size="sm"
          @click="signOut"
        />
      </div>
    </div>

    <B24Alert
      v-if="error"
      class="mb-4"
      color="air-primary-warning"
      :title="error"
    />

    <div
      class="mb-4 space-y-3"
      role="status"
      aria-live="polite"
    >
      <B24Alert
        v-for="a in alerts"
        :key="`${a.kind}:${a.queue}`"
        :color="a.kind === 'stalled' ? 'air-primary-warning' : 'air-primary-alert'"
        :title="alertTitle(a)"
        :description="a.text"
      />

      <p
        v-if="healthNote"
        class="text-sm text-(--ui-color-base-6)"
      >
        {{ healthNote }}
      </p>
    </div>

    <div class="space-y-3">
      <div
        v-for="q in queues"
        :key="q.name"
        class="rounded-xl border border-(--ui-color-base-5) p-4"
      >
        <div class="mb-2 flex items-center justify-between">
          <span class="text-sm font-medium">{{ LABELS[q.name] || q.name }}</span>
          <span class="text-xs text-(--ui-color-base-4)">{{ q.name }}</span>
        </div>
        <div class="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <span class="text-(--ui-color-base-3)">ожидают: <b>{{ q.waiting }}</b></span>
          <span class="text-(--ui-color-accent-main-primary)">в работе: <b>{{ q.active }}</b></span>
          <!-- «в хранилище», а не «за всё время» (#271-C): очередь считает СОХРАНЁННЫЕ задачи, а
               держит она последнюю тысячу выполненных и пять тысяч неудачных. Оператор читал эти
               числа как накопительный итог — это неправда. Сколько обработано на самом деле — строкой под очередями. -->
          <span class="text-(--ui-color-accent-main-success)">готово (в хранилище): <b>{{ q.completed }}</b></span>
          <!-- Провал в список ошибок (#271-B): раньше это число было тупиком. -->
          <button
            v-if="q.failed"
            type="button"
            class="text-(--ui-color-accent-main-alert) underline decoration-dotted underline-offset-2"
            :aria-expanded="failedOpen === q.name"
            @click="() => toggleFailed(q.name)"
          >
            ошибки (в хранилище): <b>{{ q.failed }}</b>{{ failedOpen === q.name ? ' ▴' : ' ▾' }}
          </button>
          <span
            v-else
            class="text-(--ui-color-base-4)"
          >ошибки (в хранилище): <b>0</b></span>
          <span
            v-if="q.delayed"
            class="text-(--ui-color-accent-main-warning)"
          >отложено: <b>{{ q.delayed }}</b></span>
        </div>
        <!-- Полосы прогресса здесь больше нет (#271-D): её шкала была выдумана (множитель 8 без
             единиц, 12 задач = 100%), подписи не имела, и 100% не означало ни «плохо», ни «хорошо».
             Осмысленная шкала — глубина очереди относительно реальной пропускной способности
             (≈900 документов в час на портал) — отдельная задача. -->
        <!-- Раскрытый список упавших задач этой очереди: причина, время, действия. -->
        <div
          v-if="failedOpen === q.name"
          class="mt-3 border-t border-(--ui-color-base-5) pt-3"
        >
          <p
            v-if="failedMsg"
            class="mb-2 text-xs text-(--ui-color-base-3)"
            role="status"
            aria-live="polite"
          >
            {{ failedMsg }}
          </p>
          <p
            v-if="failedLoading"
            class="text-xs text-(--ui-color-base-4)"
          >
            Загружаем список…
          </p>
          <B24Alert
            v-else-if="failedError"
            color="air-primary-warning"
            size="sm"
            :title="failedError"
          />
          <p
            v-else-if="failedUnavailable.includes(q.name)"
            class="text-xs text-(--ui-color-accent-main-warning)"
          >
            Список получить не удалось — очередь не ответила. Это не значит, что ошибок нет.
          </p>
          <p
            v-else-if="!failedFor(q.name).length"
            class="text-xs text-(--ui-color-base-4)"
          >
            Подробностей уже нет: очередь хранит ограниченное число упавших задач.
          </p>
          <!-- Счётчик считает все хранимые ошибки, а список показывает первые N: без этой строки
               оператор решил бы, что остальные «сами рассосались». -->
          <p
            v-if="!failedLoading && !failedError && failedLimit && q.failed > failedFor(q.name).length"
            class="mb-2 text-xs text-(--ui-color-base-4)"
          >
            Показаны первые {{ failedFor(q.name).length }} из {{ q.failed }}.
          </p>
          <ul
            v-if="!failedLoading && !failedError && failedFor(q.name).length"
            class="space-y-2"
          >
            <li
              v-for="j in failedFor(q.name)"
              :key="j.id"
              class="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-(--ui-color-base-7) p-2.5"
            >
              <span class="min-w-0 flex-1">
                <span class="block text-xs break-words text-(--ui-color-base-2)">{{ j.reason }}</span>
                <span class="block text-xs text-(--ui-color-base-4)">
                  {{ j.failedAt ? formatClock(j.failedAt) : 'время неизвестно' }} · попыток: {{ j.attempts }} · портал {{ j.portal || 'неизвестен' }} · id {{ j.id }}
                </span>
              </span>
              <span class="flex shrink-0 items-center gap-2">
                <B24Button
                  color="air-tertiary-no-accent"
                  size="xs"
                  label="Повторить"
                  :loading="failedBusy === busyKey(j)"
                  :disabled="failedBusy === busyKey(j)"
                  :aria-label="`Повторить задачу ${j.id}`"
                  @click="() => actOnFailed(j, 'retry')"
                />
                <!-- «Отбросить» стирает задачу насовсем — спрашиваем, как и на «Отзыв оставлен». -->
                <B24Button
                  v-if="confirmDiscard !== busyKey(j)"
                  color="air-tertiary-no-accent"
                  size="xs"
                  label="Отбросить"
                  :disabled="failedBusy === busyKey(j)"
                  :aria-label="`Отбросить задачу ${j.id}`"
                  @click="() => { confirmDiscard = busyKey(j) }"
                />
                <span
                  v-else
                  class="flex items-center gap-2 text-xs"
                >
                  <span class="text-(--ui-color-base-3)">Удалить насовсем?</span>
                  <B24Button
                    color="air-primary-alert"
                    size="xs"
                    label="Да"
                    :loading="failedBusy === busyKey(j)"
                    :disabled="failedBusy === busyKey(j)"
                    @click="() => actOnFailed(j, 'discard')"
                  />
                  <B24Button
                    color="air-tertiary-no-accent"
                    size="xs"
                    label="Отмена"
                    @click="() => { confirmDiscard = '' }"
                  />
                </span>
              </span>
            </li>
          </ul>
        </div>

        <!-- Оценка времени — ТОЛЬКО для записи в CRM: 900 документов в час это предел ограничителя
             портала, он относится к этой стадии. Для событий, извлечения текста и разбора цифра была
             бы такой же выдуманной, как прежняя полоса. -->
        <p
          v-if="q.name === 'crm-sync' && q.waiting + q.active > 0"
          class="mt-2 text-xs text-(--ui-color-base-4)"
        >
          в очереди сейчас {{ q.waiting + q.active }} — это не меньше {{ backlogHours(q.waiting + q.active) }}
          (порталы разбираются параллельно, каждый со своим ограничителем)
        </p>
      </div>
      <p
        v-if="!queues.length && !error"
        class="rounded-lg border border-(--ui-color-base-5) p-6 text-center text-sm text-(--ui-color-base-4)"
      >
        Нет данных по очередям
      </p>
      <!-- Объём обработки (#271-C). Отделён чертой и подписан отдельно: числа выше — только то, что
           ещё хранится в очереди, и путать их с этой строкой нельзя (ради чего пункт и заводился). -->
      <div
        v-if="lifetimeText || totalsFailed"
        class="mt-4 border-t border-(--ui-color-base-5) pt-3 text-xs text-(--ui-color-base-3)"
      >
        <span class="font-semibold">По всем установленным порталам:</span>
        <span v-if="lifetimeText"> {{ lifetimeText }}.</span>
        <span
          v-else
          class="text-(--ui-color-accent-main-warning)"
        > не удалось прочитать — база недоступна.</span>
        <span class="block text-(--ui-color-base-4)">
          Числа выше — только то, что ещё хранится в очереди. Это — сколько обработано на самом деле;
          при удалении приложения счётчики портала стираются, поэтому число может уменьшиться.
        </span>
      </div>
    </div>

    <!-- Авторизация порталов (#132) — статус токенов, без секретов -->
    <!-- Блок виден ВСЕГДА (#271-F): раньше при пустом списке исчезал вместе с заголовком, и
         оператор на свежем стенде не узнавал, что такой раздел вообще есть. -->
    <div class="mt-8">
      <h2 class="mb-3 text-sm font-semibold text-(--ui-color-base-2)">
        Авторизация порталов
      </h2>
      <B24Alert
        v-if="portalsError"
        class="mb-2"
        color="air-primary-warning"
        size="sm"
        :title="portalsError"
      />
      <p
        v-else-if="!portals.length"
        class="mb-2 text-sm text-(--ui-color-base-4)"
      >
        Приложение пока не установлено ни на один портал.
      </p>
      <p
        v-if="reauthMsg"
        class="mb-2 text-xs text-(--ui-color-base-3)"
        role="status"
      >
        {{ reauthMsg }}
      </p>
      <!-- Поиск + порядок «сломанные наверх» (#271-J): плоский список перестаёт работать ровно
           тогда, когда консоль нужнее всего — портал с умершим токеном тонет среди здоровых. -->
      <div
        v-if="portals.length"
        class="mb-2 flex flex-wrap items-center gap-2"
      >
        <B24Input
          v-model="portalQuery"
          :icon="SearchIcon"
          size="sm"
          type="search"
          placeholder="Поиск по домену или member_id"
          class="w-72"
          aria-label="Поиск портала"
        />
        <!-- Отбор по состоянию, а не только сортировка: «покажи все сломанные» текстовым поиском не
             выразить — состояние в домен не записано. -->
        <B24Button
          :color="healthFilter === 'all' ? 'air-secondary-accent' : 'air-tertiary-no-accent'"
          size="xs"
          label="Все"
          @click="() => { healthFilter = 'all' }"
        />
        <B24Button
          :color="healthFilter === 'problem' ? 'air-secondary-accent' : 'air-tertiary-no-accent'"
          size="xs"
          :label="`С проблемой (${problemCount})`"
          @click="() => { healthFilter = 'problem' }"
        />
        <span
          v-if="portalsFiltered"
          class="text-xs text-(--ui-color-base-4)"
          role="status"
        >
          показано {{ shownPortals.length }} из {{ portals.length }}
        </span>
      </div>
      <p
        v-if="portals.length && !shownPortals.length"
        class="mb-2 text-sm break-words text-(--ui-color-base-4)"
      >
        Ничего не найдено{{ portalQuery.trim() ? ` по запросу «${portalQuery}»` : '' }}.
        <button
          type="button"
          class="underline decoration-dotted underline-offset-2"
          @click="resetPortalFilters"
        >
          Показать все
        </button>
      </p>
      <div class="space-y-2">
        <div
          v-for="p in shownPortals"
          :key="p.memberId"
          class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-(--ui-color-base-5) p-3"
        >
          <span class="flex flex-col">
            <span class="text-sm font-medium">{{ p.domain }}</span>
            <!-- member_id на экране (#271-K): все действия идут по нему, и он же нужен для логов,
                 SQL и сверки с телеметрией — а раньше показывался только домен. -->
            <button
              type="button"
              class="text-left font-mono text-[11px] text-(--ui-color-base-4) underline decoration-dotted underline-offset-2"
              :aria-label="copiedMember === p.memberId
                ? `member_id портала ${p.domain} скопирован`
                : `Скопировать member_id портала ${p.domain}`"
              @click="() => copyMemberId(p.memberId)"
            >
              {{ p.memberId }}
            </button>
            <!-- Подтверждение — отдельной живой областью в СВОЕЙ строке: внутри кнопки его съедал бы
                 её же aria-label, а общая на весь список выглядела бы относящейся к любому порталу. -->
            <span
              v-if="copiedMember === p.memberId || copyFailed === p.memberId"
              class="text-[11px]"
              :class="copyFailed === p.memberId ? 'text-(--ui-color-accent-main-warning)' : 'text-(--ui-color-base-4)'"
              role="status"
              aria-live="polite"
            >{{ copyFailed === p.memberId ? 'Скопировать не удалось — выделите и скопируйте вручную' : 'Скопировано' }}</span>
          </span>
          <span class="flex flex-wrap items-center gap-x-4 text-sm">
            <span :class="HEALTH_META[p.health].cls">{{ HEALTH_META[p.health].label }}</span>
            <span class="text-(--ui-color-base-3)">{{
              p.expiresInDays > 0 ? `refresh_token ≈ ${p.expiresInDays} дн.` : 'срок истёк'
            }}</span>
            <B24Button
              color="air-tertiary-no-accent"
              size="xs"
              :loading="reauthing === p.memberId"
              :disabled="reauthing === p.memberId"
              :label="reauthing === p.memberId ? 'Обновление…' : 'Переавторизовать'"
              :aria-label="`Переавторизовать портал ${p.domain}`"
              @click="() => reauth(p.memberId)"
            />
          </span>
        </div>
      </div>
    </div>

    <!-- Объявление клиентам (#469): текст, картинка и ссылка задаются здесь, показ — один раз на
         сотрудника. Отдельным компонентом, а не блоком в этой странице: у него своя форма, свой
         предпросмотр и два шага отправки, и внутри и без того длинного экрана это не читалось бы. -->
    <OpsAnnouncementCard />

    <!-- Оценки приложения — управление жизненным циклом «оцените приложение» вручную (не через SQL) -->
    <div class="mt-8">
      <h2 class="mb-1 text-sm font-semibold text-(--ui-color-base-2)">
        Оценки приложения
      </h2>
      <B24Alert
        v-if="ratingsError"
        class="mb-2"
        color="air-primary-warning"
        size="sm"
        :title="ratingsError"
      />
      <p class="mb-3 text-xs text-(--ui-color-base-4)">
        После клика «Оценить» проверьте отзыв в Маркете и отметьте: «Отзыв оставлен» (попап больше не
        покажется) или «Сбросить» (покажется снова).
      </p>
      <p
        v-if="ratingMsg"
        class="mb-2 text-xs text-(--ui-color-base-3)"
        role="status"
      >
        {{ ratingMsg }}
      </p>
      <p
        v-if="!ratingsError && !ratings.length"
        class="mb-2 text-sm text-(--ui-color-base-4)"
      >
        Пока ни одному порталу попап не показывался.
      </p>
      <div class="space-y-2">
        <div
          v-for="r in ratings"
          :key="r.memberId"
          class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-(--ui-color-base-5) p-3"
        >
          <span class="flex flex-col">
            <span class="text-sm font-medium">{{ r.domain }}</span>
            <span class="text-xs text-(--ui-color-base-4)">
              показан: {{ fmtDate(r.promptedAtMs) }} · открыл: {{ fmtDate(r.openedAtMs) }}
            </span>
          </span>
          <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span
              class="text-sm"
              :class="RATING_META[r.state].cls"
            >{{ RATING_META[r.state].label }}</span>
            <!-- Подтверждение отзыва — в два шага (#271-I). Снять его теперь можно (#318 п.2), но
                 это всё равно значимое действие: пока отметка стоит, попап портал не беспокоит. -->
            <B24Button
              v-if="r.state !== 'reviewed' && confirmReviewed !== r.memberId"
              color="air-tertiary-no-accent"
              size="xs"
              :loading="ratingBusy === r.memberId"
              :disabled="ratingBusy === r.memberId"
              label="Отзыв оставлен"
              :aria-label="`Отметить, что портал ${r.domain} оставил отзыв`"
              @click="() => { confirmReviewed = r.memberId }"
            />
            <span
              v-else-if="r.state !== 'reviewed'"
              class="flex flex-wrap items-center gap-2 text-xs"
            >
              <span class="text-(--ui-color-base-3)">Отметить окончательно? Отменить можно будет только через базу.</span>
              <B24Button
                color="air-primary-alert"
                size="xs"
                :loading="ratingBusy === r.memberId"
                :disabled="ratingBusy === r.memberId"
                label="Да, отзыв оставлен"
                @click="() => setRating(r.memberId, 'reviewed')"
              />
              <B24Button
                color="air-tertiary-no-accent"
                size="xs"
                label="Отмена"
                @click="() => { confirmReviewed = '' }"
              />
            </span>
            <B24Button
              v-if="r.state === 'opened' || r.state === 'prompted'"
              color="air-tertiary-no-accent"
              size="xs"
              :loading="ratingBusy === r.memberId"
              :disabled="ratingBusy === r.memberId"
              label="Сбросить"
              :aria-label="`Сбросить флаг оценки для портала ${r.domain}`"
              @click="() => setRating(r.memberId, 'reset')"
            />
            <!-- Отмена подтверждения (#318 п.2). Раньше «отзыв оставлен» был тупиком: ошибочный клик
                 откатывался только через базу — а ошибаются здесь легко, строки идут подряд и кнопки
                 рядом. Возврат — строго в состояние ДО подтверждения, ни шагом дальше: метки показов
                 не трогаем. ⚠ Обычно это состояние «открывал Маркет», а оно молчит бессрочно, а не
                 до конца срока, — поэтому после снятия отметки строке нужен ещё «Сбросить», и текст
                 подсказки говорит это прямо. Два шага — как у остальных значимых действий. -->
            <B24Button
              v-if="r.state === 'reviewed' && confirmUnreview !== r.memberId"
              color="air-tertiary-no-accent"
              size="xs"
              :loading="ratingBusy === r.memberId"
              :disabled="ratingBusy === r.memberId"
              label="Снять отметку об отзыве"
              :aria-label="`Отменить отметку об отзыве для портала ${r.domain}`"
              @click="() => { confirmUnreview = r.memberId }"
            />
            <span
              v-else-if="r.state === 'reviewed'"
              class="flex flex-wrap items-center gap-2 text-xs"
            >
              <span class="text-(--ui-color-base-3)">Снять отметку об отзыве? Портал вернётся в состояние до подтверждения — чтобы попап показался снова, после этого нажмите «Сбросить».</span>
              <B24Button
                color="air-primary"
                size="xs"
                :loading="ratingBusy === r.memberId"
                :disabled="ratingBusy === r.memberId"
                label="Да, снять"
                @click="() => setRating(r.memberId, 'unreview')"
              />
              <B24Button
                color="air-tertiary-no-accent"
                size="xs"
                label="Отмена"
                @click="() => { confirmUnreview = '' }"
              />
            </span>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
