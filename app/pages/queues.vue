<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import { useAuth } from '~/composables/useAuth'
import { QUEUES_REFRESH_MS, formatClock, staleAfter } from '~/utils/opsMonitor'
import { APP_NAME } from '~/config/appIdentity'

// Operator queue monitor (service zone). Auth-gated (server 401 + client redirect).
// Layout `clear`, noindex, prerendered (shell; data loads client-side).
//
// РАСКЛАДКА (#523). Страница держит только то, что общее для всех блоков: вход, шапку с отметкой
// времени и автообновлением, выход. Сами блоки — `QueueMonitor`, `OpsPortalsCard`,
// `OpsRatingsCard`, `OpsAnnouncementCard` — грузят своё состояние сами и отдают наружу `reload()`.
// Прежде здесь лежали 895 строк: три запроса, три набора ошибок и четыре подтверждения вперемешку,
// и найти нужное место было дороже, чем внести саму правку.
//
// ⚠ Дизайн служебной зоны намеренно не прорабатывается — это консоль владельца, а не продукт.
// Разгрузка страницы к дизайну отношения не имеет: она про то, чтобы правка одного блока не читала
// и не ломала два соседних.
definePageMeta({ layout: 'clear' })
// Заголовок вкладки называет ПРОДУКТ (#318 п.1): у владельца открыто несколько служебных консолей
// разных продуктов, и по вкладке «Служебная консоль» они неразличимы.
useHead({ title: `Служебная консоль / ${APP_NAME}`, meta: [{ name: 'robots', content: 'noindex' }] })

const { authenticated, check, logout } = useAuth()
const router = useRouter()

interface OpsBlock { reload: () => Promise<void> }
const monitor = ref<OpsBlock | null>(null)
const portalsCard = ref<OpsBlock | null>(null)
const ratingsCard = ref<OpsBlock | null>(null)

const loading = ref(false)
// Когда данные последний раз обновлялись (#271-A). Без этой отметки замороженный снимок неотличим
// от живого. ⚠ Отметку ставит блок ОЧЕРЕДЕЙ и только на успехе своего запроса: она про свежесть
// цифр очередей, и перечитанный список оценок их свежее не делает.
const updatedAt = ref<number | null>(null)
const autoRefresh = ref(true)
// Тикает раз в секунду, чтобы «данные устарели» появлялось само, без нового запроса.
const nowMs = ref(Date.now())
const stale = computed(() => staleAfter(updatedAt.value, nowMs.value))

async function load(): Promise<void> {
  loading.value = true
  try {
    // Блоки независимы, поэтому идут параллельно, а не по очереди: у каждого свой эндпоинт и своя
    // ошибка, и упавший запрос состояния порталов не должен задерживать отрисовку очередей.
    await Promise.all([monitor.value?.reload(), portalsCard.value?.reload(), ratingsCard.value?.reload()])
  } finally {
    loading.value = false
  }
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
onBeforeUnmount(stopAuto)

/**
 * Сессия истекла — уводим на вход.
 *
 * ⚠ Блоки грузятся параллельно, поэтому о просроченной сессии сообщат все три сразу: без замка
 * получилось бы три навигации подряд. ⚠ Автообновление гасим ДО ухода — иначе вкладка успевает
 * послать ещё один круг запросов заведомо просроченной сессией.
 */
let leaving = false
async function onUnauthorized(): Promise<void> {
  if (leaving) return
  leaving = true
  stopAuto()
  await router.push('/login')
}

async function signOut(): Promise<void> {
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

    <!-- Очереди, тревоги, упавшие задачи и объём обработки. -->
    <QueueMonitor
      ref="monitor"
      :now-ms="nowMs"
      @updated="(ms: number) => { updatedAt = ms }"
      @unauthorized="onUnauthorized"
    />

    <!-- Авторизация порталов (#132) — статус токенов, без секретов. -->
    <OpsPortalsCard
      ref="portalsCard"
      @unauthorized="onUnauthorized"
    />

    <!-- Объявление клиентам (#469): текст, картинка и ссылка задаются здесь, показ — один раз на
         сотрудника. Своё состояние и два шага отправки у него внутри — страница о них не знает. -->
    <OpsAnnouncementCard />

    <!-- Оценки приложения — управление жизненным циклом «оцените приложение» вручную (не через SQL). -->
    <OpsRatingsCard
      ref="ratingsCard"
      @unauthorized="onUnauthorized"
    />
  </div>
</template>
