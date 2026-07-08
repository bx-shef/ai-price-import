<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAuth } from '~/composables/useAuth'

// Operator queue monitor (service zone). Auth-gated (server 401 + client redirect).
// Layout `clear`, noindex, prerendered (shell; data loads client-side).
definePageMeta({ layout: 'clear' })
useHead({ title: 'Очереди импорта', meta: [{ name: 'robots', content: 'noindex' }] })

interface QueueCounts { name: string, waiting: number, active: number, completed: number, failed: number, delayed: number }

const { authenticated, check, logout } = useAuth()
const router = useRouter()
const queues = ref<QueueCounts[]>([])
const error = ref('')
const loading = ref(false)

const LABELS: Record<string, string> = {
  'b24-events': 'События B24',
  'file-extract': 'Извлечение текста',
  'agent-run': 'AI-разбор',
  'crm-sync': 'Запись в CRM'
}

async function load() {
  loading.value = true
  try {
    const r = await $fetch<{ queues: QueueCounts[] }>('/api/ops/queues')
    queues.value = r.queues
    error.value = ''
  } catch {
    error.value = 'Нет доступа или сервис недоступен'
  } finally {
    loading.value = false
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
      <div class="flex items-center gap-3">
        <button
          type="button"
          class="text-sm text-blue-600 hover:underline disabled:opacity-50"
          :disabled="loading"
          @click="load"
        >
          {{ loading ? 'Обновление…' : 'Обновить' }}
        </button>
        <button
          type="button"
          class="text-sm text-gray-500 hover:underline"
          @click="signOut"
        >
          Выйти
        </button>
      </div>
    </div>

    <p
      v-if="error"
      class="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700"
    >
      {{ error }}
    </p>

    <div class="space-y-3">
      <div
        v-for="q in queues"
        :key="q.name"
        class="rounded-xl border border-gray-200 p-4"
      >
        <div class="mb-2 flex items-center justify-between">
          <span class="text-sm font-medium">{{ LABELS[q.name] || q.name }}</span>
          <span class="text-xs text-gray-400">{{ q.name }}</span>
        </div>
        <div class="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <span class="text-gray-600">ожидают: <b class="text-gray-900">{{ q.waiting }}</b></span>
          <span class="text-blue-600">в работе: <b>{{ q.active }}</b></span>
          <span class="text-green-600">готово: <b>{{ q.completed }}</b></span>
          <span class="text-red-600">ошибки: <b>{{ q.failed }}</b></span>
          <span
            v-if="q.delayed"
            class="text-amber-600"
          >отложено: <b>{{ q.delayed }}</b></span>
        </div>
        <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
          <div
            class="h-full bg-blue-500"
            :style="{ width: Math.min(100, (q.waiting + q.active) * 8) + '%' }"
          />
        </div>
      </div>
      <p
        v-if="!queues.length && !error"
        class="rounded-lg border border-gray-200 p-6 text-center text-sm text-gray-400"
      >
        Нет данных по очередям
      </p>
    </div>
  </div>
</template>
