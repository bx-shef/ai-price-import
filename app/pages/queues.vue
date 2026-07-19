<script setup lang="ts">
import { onMounted, ref } from 'vue'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import { useAuth } from '~/composables/useAuth'

// Operator queue monitor (service zone). Auth-gated (server 401 + client redirect).
// Layout `clear`, noindex, prerendered (shell; data loads client-side).
definePageMeta({ layout: 'clear' })
useHead({ title: 'Очереди импорта', meta: [{ name: 'robots', content: 'noindex' }] })

interface QueueCounts { name: string, waiting: number, active: number, completed: number, failed: number, delayed: number }
interface PortalStatus { memberId: string, domain: string, ageDays: number, expiresInDays: number, health: 'ok' | 'near-expiry' | 'stale' }

const { authenticated, check, logout } = useAuth()
const router = useRouter()
const queues = ref<QueueCounts[]>([])
const portals = ref<PortalStatus[]>([])
const error = ref('')
const loading = ref(false)

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

async function load() {
  loading.value = true
  try {
    const r = await $fetch<{ queues: QueueCounts[] }>('/api/ops/queues')
    queues.value = r.queues
    error.value = ''
  } catch (e) {
    // Cookie expired while the page was open → back to sign-in.
    if ((e as { statusCode?: number })?.statusCode === 401) {
      await router.push('/login')
      return
    }
    error.value = 'Сервис недоступен'
  } finally {
    loading.value = false
  }
  // Portal auth status — best-effort, must not blank the queues view on its own failure.
  try {
    const t = await $fetch<{ portals: PortalStatus[] }>('/api/ops/tokens')
    portals.value = t.portals
  } catch { /* non-fatal */ }
}

// Force-refresh one portal's OAuth token from the UI (#132) — no SSH, no secret in the browser.
const reauthing = ref<string>('') // member_id currently refreshing (disables its button)
const reauthMsg = ref<string>('')
async function reauth(memberId: string) {
  reauthing.value = memberId
  reauthMsg.value = ''
  try {
    await $fetch('/api/ops/tokens/refresh', { method: 'POST', body: { memberId } })
    reauthMsg.value = 'Токен обновлён'
    await load() // re-pull status so the row's expiry resets
  } catch (e) {
    const code = (e as { statusCode?: number })?.statusCode
    if (code === 401) {
      // Session expired mid-page — same handling as load(), not a fake «failed».
      await router.push('/login')
      return
    }
    reauthMsg.value = code === 409 ? 'Портал не установлен' : code === 503 ? 'OAuth не настроен' : 'Не удалось обновить'
  } finally {
    reauthing.value = ''
  }
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
})
</script>

<template>
  <div class="mx-auto max-w-3xl p-4 sm:p-6">
    <div class="mb-5 flex items-center justify-between">
      <h1 class="text-xl font-semibold">
        Очереди импорта
      </h1>
      <div class="flex items-center gap-2">
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
          <span class="text-(--ui-color-accent-main-success)">готово: <b>{{ q.completed }}</b></span>
          <span class="text-(--ui-color-accent-main-alert)">ошибки: <b>{{ q.failed }}</b></span>
          <span
            v-if="q.delayed"
            class="text-(--ui-color-accent-main-warning)"
          >отложено: <b>{{ q.delayed }}</b></span>
        </div>
        <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-(--ui-color-base-5)">
          <div
            class="h-full bg-(--ui-color-accent-main-primary)"
            :style="{ width: Math.min(100, (q.waiting + q.active) * 8) + '%' }"
          />
        </div>
      </div>
      <p
        v-if="!queues.length && !error"
        class="rounded-lg border border-(--ui-color-base-5) p-6 text-center text-sm text-(--ui-color-base-4)"
      >
        Нет данных по очередям
      </p>
    </div>

    <!-- Авторизация порталов (#132) — статус токенов, без секретов -->
    <div
      v-if="portals.length"
      class="mt-8"
    >
      <h2 class="mb-3 text-sm font-semibold text-(--ui-color-base-2)">
        Авторизация порталов
      </h2>
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
              :disabled="reauthing !== ''"
              :label="reauthing === p.memberId ? 'Обновление…' : 'Переавторизовать'"
              :aria-label="`Переавторизовать портал ${p.domain}`"
              @click="() => reauth(p.memberId)"
            />
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
