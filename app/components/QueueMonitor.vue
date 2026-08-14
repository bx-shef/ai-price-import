<script setup lang="ts">
import { computed, ref } from 'vue'
import { ALL_QUEUES, QUEUE_HEALTH_STALE_MS, backlogHours, formatClock, lifetimeSummary, staleAfter } from '~/utils/opsMonitor'

// Состояние очередей в служебной консоли: тревоги, карточки очередей, список упавших задач и объём
// обработки по всем порталам (#523, по образцу `QueueMonitor.vue` родственного проекта).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ КОМПОНЕНТ. `pages/queues.vue` была самой тяжёлой страницей проекта — 895 строк, и
// в ней рядом жили три независимых блока с тремя своими запросами, тремя своими ошибками и тремя
// наборами подтверждений. Найти в этом нужное место было дороже, чем внести саму правку.
//
// ⚠ Данные компонент грузит САМ и отдаёт наружу `reload()`: страница держит только автообновление и
// отметку времени. Отметку ставит именно этот блок (`updated`) — она про снимок ОЧЕРЕДЕЙ, и
// перерисовка списка оценок не делает цифры очередей свежее.
// ⚠ 401 не обрабатывается тут: уводить со страницы — дело страницы, у неё и роутер, и остальные
// блоки, которые надо остановить.

const props = defineProps<{
  /** Тикающие «сейчас» со страницы: по ним стареет отметка проверки здоровья. */
  nowMs: number
}>()

const emit = defineEmits<{
  /** Сессия истекла — увести на вход. */
  unauthorized: []
  /** Снимок очередей успешно получен; аргумент — время успеха, а не время попытки. */
  updated: [ms: number]
}>()

interface QueueCounts { name: string, waiting: number, active: number, completed: number, failed: number, delayed: number }
interface QueueAlert { kind: 'stalled' | 'failing' | 'unreadable', queue: string, text: string }
// `portal` — необратимый отпечаток портала (#498). Без него «сорок отказов подряд» нельзя было
// связать с конкретным клиентом, и ручной разбор упирался в отдельную раскопку по логам.
interface FailedJob { queue: string, id: string, reason: string, failedAt: number | null, attempts: number, portal?: string }

const queues = ref<QueueCounts[]>([])
const error = ref('')
const loading = ref(false)
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

const LABELS: Record<string, string> = {
  'b24-events': 'События B24',
  'file-extract': 'Извлечение текста',
  'agent-run': 'AI-разбор',
  'crm-sync': 'Запись в CRM'
}

// Возраст проверки — не украшение. Проверка, отработавшая шесть часов назад, ничего не говорит о
// «сейчас», и рисовать её так же, как свежую, — та же ложь, что показывать непрочитанную очередь
// здоровой. Поэтому у отсутствия тревог три разных смысла, и экран их различает.
const healthNote = computed(() => {
  if (loading.value || error.value) return ''
  if (alertsCheckedAt.value === null) {
    return 'Проверка здоровья очередей ещё не отработала — это не значит, что всё в порядке.'
  }
  if (staleAfter(alertsCheckedAt.value, props.nowMs, QUEUE_HEALTH_STALE_MS)) {
    return `Последняя проверка здоровья очередей — в ${formatClock(alertsCheckedAt.value)}, данные устарели.`
  }
  return ''
})
const lifetimeText = computed(() => lifetimeSummary(totals.value
  ? { docs: totals.value.docs ?? 0, created: totals.value.created ?? 0, lines: totals.value.lines ?? 0, errors: totals.value.errors ?? 0 }
  : null))

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
const { text: failedMsg, flash: flashFailed } = useFlashMessage()
// «Отбросить» стирает задачу из очереди насовсем — откатить нельзя вообще. Для куда более мягкого
// «Отзыв оставлен» подтверждение уже есть; здесь оно тем более обязательно.
const confirmDiscard = ref('')
/** Ключ занятости — очередь + идентификатор: id уникален внутри очереди, а не глобально. */
const busyKey = (j: FailedJob) => `${j.queue}|${j.id}`

/** 401 в любом запросе блока значит одно: сессия истекла. Решение — за страницей. */
function isExpired(e: unknown): boolean {
  return (e as { statusCode?: number })?.statusCode === 401
}

// Токен последовательности: ручное «Обновить», действие оператора и автоцикл могут наложиться, и
// ответ более СТАРОГО вызова записался бы поверх свежего. Пишем только результат последнего.
let loadSeq = 0
async function load(): Promise<void> {
  const my = ++loadSeq
  loading.value = true
  try {
    const r = await $fetch<{ queues: QueueCounts[], totals: Record<string, number> | null, totalsFailed?: boolean, alerts?: QueueAlert[], alertsCheckedAt?: number | null }>('/api/ops/queues')
    if (my !== loadSeq) return
    queues.value = r.queues
    totals.value = r.totals ?? null
    totalsFailed.value = r.totalsFailed === true
    alerts.value = r.alerts ?? []
    alertsCheckedAt.value = r.alertsCheckedAt ?? null
    error.value = ''
    loading.value = false
    // Штампуем время УСПЕХА, а не факт попытки. Иначе при молча отвалившихся запросах экран
    // показывал бы свежую отметку над старыми цифрами — ровно тот случай, ради которого признак
    // «данные устарели» и заводился.
    emit('updated', Date.now())
  } catch (e) {
    if (my !== loadSeq) return
    loading.value = false
    // Cookie expired while the page was open → back to sign-in.
    if (isExpired(e)) {
      emit('unauthorized')
      return
    }
    error.value = 'Сервис недоступен'
  }
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
    if (isExpired(e)) {
      emit('unauthorized')
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
    flashFailed(r.ok
      ? (action === 'retry' ? 'Задача снова в очереди' : 'Задача отброшена')
      : 'Задачи уже нет — список обновлён')
    failedJobs.value = failedJobs.value.filter(j => !(j.queue === job.queue && j.id === job.id))
    await load() // счётчик «ошибки» на карточке должен сойтись со списком
  } catch (e) {
    if (isExpired(e)) {
      emit('unauthorized')
      return
    }
    flashFailed('Не удалось выполнить действие')
  } finally {
    failedBusy.value = ''
  }
}

/** Упавшие задачи только этой очереди — список приходит сразу по всем. */
function failedFor(queue: string): FailedJob[] {
  return failedJobs.value.filter(j => j.queue === queue)
}

/** Перечитать снимок очередей (зовёт страница: ручное «Обновить» и автоцикл). */
defineExpose({ reload: load })
</script>

<template>
  <div>
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
  </div>
</template>
