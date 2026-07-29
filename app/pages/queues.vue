<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import { useAuth } from '~/composables/useAuth'
import { FLASH_MS, QUEUES_REFRESH_MS, backlogHours, formatClock, staleAfter } from '~/utils/opsMonitor'

// Operator queue monitor (service zone). Auth-gated (server 401 + client redirect).
// Layout `clear`, noindex, prerendered (shell; data loads client-side).
definePageMeta({ layout: 'clear' })
useHead({ title: 'Очереди импорта', meta: [{ name: 'robots', content: 'noindex' }] })

interface QueueCounts { name: string, waiting: number, active: number, completed: number, failed: number, delayed: number }
interface PortalStatus { memberId: string, domain: string, ageDays: number, expiresInDays: number, health: 'ok' | 'near-expiry' | 'stale' }
type RatingState = 'reviewed' | 'opened' | 'prompted' | 'none'
interface RatingStatus { memberId: string, domain: string, state: RatingState, promptedAtMs: number | null, openedAtMs: number | null }

const { authenticated, check, logout } = useAuth()
const router = useRouter()
const queues = ref<QueueCounts[]>([])
const portals = ref<PortalStatus[]>([])
const ratings = ref<RatingStatus[]>([])
const error = ref('')
// У КАЖДОГО блока своя ошибка (#271-E). Раньше два из трёх запросов падали в `catch {}`, блок просто
// не отрисовывался, и оператор не отличал «порталов нет» от «запрос упал». На служебном экране
// молчание опаснее лишнего сообщения.
const portalsError = ref('')
const ratingsError = ref('')
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
    const r = await $fetch<{ queues: QueueCounts[] }>('/api/ops/queues')
    if (my !== loadSeq) return
    queues.value = r.queues
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
async function setRating(memberId: string, action: 'reviewed' | 'reset') {
  ratingBusy.value = memberId
  ratingMsg.value = ''
  confirmReviewed.value = ''
  try {
    await $fetch('/api/ops/app-rating', { method: 'POST', body: { memberId, action } })
    flash(ratingMsg, action === 'reviewed' ? 'Отмечено как «отзыв оставлен»' : 'Флаг сброшен — попап покажется снова')
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
        Очереди импорта
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
               числа как накопительный итог — это неправда. Настоящий итог — на «Метриках импорта». -->
          <span class="text-(--ui-color-accent-main-success)">готово (в хранилище): <b>{{ q.completed }}</b></span>
          <span class="text-(--ui-color-accent-main-alert)">ошибки (в хранилище): <b>{{ q.failed }}</b></span>
          <span
            v-if="q.delayed"
            class="text-(--ui-color-accent-main-warning)"
          >отложено: <b>{{ q.delayed }}</b></span>
        </div>
        <!-- Полосы прогресса здесь больше нет (#271-D): её шкала была выдумана (множитель 8 без
             единиц, 12 задач = 100%), подписи не имела, и 100% не означало ни «плохо», ни «хорошо».
             Осмысленная шкала — глубина очереди относительно реальной пропускной способности
             (≈900 документов в час на портал) — отдельная задача. -->
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
      <div class="space-y-2">
        <div
          v-for="p in portals"
          :key="p.memberId"
          class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-(--ui-color-base-5) p-3"
        >
          <span class="text-sm font-medium">{{ p.domain }}</span>
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
            <!-- «Отзыв оставлен» необратимо: состояние терминальное, кнопки сброса у него уже нет,
                 откат — только через SQL. Поэтому в два шага, как у нас принято на действиях куда
                 безобиднее (#271-I). -->
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
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
