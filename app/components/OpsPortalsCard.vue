<script setup lang="ts">
import { computed, ref } from 'vue'
import SearchIcon from '@bitrix24/b24icons-vue/outline/SearchIcon'
import { visiblePortals, type PortalHealthFilter } from '~/utils/opsMonitor'
import { copyToClipboard } from '~/utils/clipboard'

// Авторизация порталов в служебной консоли (#132, вынесено из `pages/queues.vue` в #523): состояние
// токенов без единого секрета на экране, поиск, отбор «сломанные» и ручная переавторизация.
//
// ⚠ Блок грузит своё состояние САМ и отдаёт наружу `reload()`. Своя ошибка у него тоже своя (#271-E):
// раньше запрос падал в `catch {}`, блок просто не отрисовывался, и оператор не отличал «порталов
// нет» от «запрос упал». На служебном экране молчание опаснее лишнего сообщения.
// ⚠ 401 уходит наверх событием: увести на вход — дело страницы, у неё роутер и остальные блоки.

const emit = defineEmits<{ unauthorized: [] }>()

interface PortalStatus { memberId: string, domain: string, ageDays: number, expiresInDays: number, health: 'ok' | 'near-expiry' | 'stale' }

const portals = ref<PortalStatus[]>([])
const portalsError = ref('')

// Non-secret auth health (#132) — the token itself is never sent here.
const HEALTH_META: Record<PortalStatus['health'], { label: string, cls: string }> = {
  'ok': { label: 'активен', cls: 'text-(--ui-color-accent-main-success)' },
  'near-expiry': { label: 'скоро истекает', cls: 'text-(--ui-color-accent-main-warning)' },
  'stale': { label: 'нужна переустановка', cls: 'text-(--ui-color-accent-main-alert)' }
}

// Поиск по порталам (#271-J): и по домену, и по member_id — у оператора на руках бывает именно id.
// Отдельно отбор по состоянию: сортировки «сломанные наверх» мало, когда порталов много, а в домен
// состояние не впишешь, поэтому текстовым поиском его не найти.
const portalQuery = ref('')
const healthFilter = ref<PortalHealthFilter>('all')
const shownPortals = computed(() => visiblePortals(portals.value, portalQuery.value, healthFilter.value))
const problemCount = computed(() => portals.value.filter(p => p.health !== 'ok').length)
/** Отбор активен — значит «показано N из M» несёт смысл; без него это просто «5 из 5». */
const portalsFiltered = computed(() => !!portalQuery.value.trim() || healthFilter.value !== 'all')

/** Сбросить оба отбора — иначе из пустого списка нет выхода, кроме как стереть запрос вручную. */
function resetPortalFilters(): void {
  portalQuery.value = ''
  healthFilter.value = 'all'
}

function isExpired(e: unknown): boolean {
  return (e as { statusCode?: number })?.statusCode === 401
}

// Токен последовательности: ручное «Обновить», переавторизация и автоцикл могут наложиться, и ответ
// более СТАРОГО вызова записался бы поверх свежего.
let loadSeq = 0
async function load(): Promise<void> {
  const my = ++loadSeq
  try {
    const t = await $fetch<{ portals: PortalStatus[] }>('/api/ops/tokens')
    if (my !== loadSeq) return
    portals.value = t.portals
    portalsError.value = ''
  } catch (e) {
    if (my !== loadSeq) return
    // 401 здесь означает то же, что и на очередях: сессия истекла. Раньше любой статус схлопывался
    // в «не удалось», и вкладка продолжала долбить эндпоинт каждые 12 секунд с неверной причиной.
    if (isExpired(e)) {
      emit('unauthorized')
      return
    }
    portalsError.value = 'Не удалось получить состояние порталов'
  }
}

// Force-refresh one portal's OAuth token from the UI (#132) — no SSH, no secret in the browser.
const reauthing = ref<string>('') // member_id currently refreshing (disables its button)
const { text: reauthMsg, flash: flashReauth, clear: clearReauthMsg } = useFlashMessage()
async function reauth(memberId: string): Promise<void> {
  reauthing.value = memberId
  clearReauthMsg() // иначе до ответа сервера висит исход ПРЕДЫДУЩЕГО портала
  try {
    await $fetch('/api/ops/tokens/refresh', { method: 'POST', body: { memberId } })
    flashReauth('Токен обновлён')
    await load() // re-pull status so the row's expiry resets
  } catch (e) {
    // Session expired mid-page — same handling as load(), not a fake «failed».
    if (isExpired(e)) {
      emit('unauthorized')
      return
    }
    const code = (e as { statusCode?: number })?.statusCode
    flashReauth(code === 409 ? 'Портал не установлен' : code === 503 ? 'OAuth не настроен' : 'Не удалось обновить')
  } finally {
    reauthing.value = ''
  }
}

// Копирование member_id (#271-K). Подтверждение живёт в самой строке и гаснет само — общая строка
// «скопировано» на весь список выглядела бы относящейся к любому порталу (та же ошибка, что #271-G).
const { text: copiedMember, flash: flashCopied } = useFlashMessage()
const { text: copyFailed, flash: flashCopyFailed } = useFlashMessage()
async function copyMemberId(memberId: string): Promise<void> {
  // Молчаливый отказ недопустим: без защищённого соединения или при запрете доступа к буферу клик
  // просто ничего не делал, и оператор уходил с уверенностью, что id у него скопирован.
  if (await copyToClipboard(memberId)) flashCopied(memberId)
  else flashCopyFailed(memberId)
}

/** Перечитать состояние токенов (зовёт страница: ручное «Обновить» и автоцикл). */
defineExpose({ reload: load })
</script>

<template>
  <!-- Блок виден ВСЕГДА (#271-F): раньше при пустом списке исчезал вместе с заголовком, и оператор
       на свежем стенде не узнавал, что такой раздел вообще есть. -->
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
</template>
