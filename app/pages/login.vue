<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAuth } from '~/composables/useAuth'

// Operator sign-in (service zone). Layout `clear`, noindex, prerendered.
definePageMeta({ layout: 'clear' })
useHead({ title: 'Вход оператора', meta: [{ name: 'robots', content: 'noindex' }] })

const { login, error, enabled, authenticated, check } = useAuth()
const router = useRouter()
const password = ref('')
const busy = ref(false)

onMounted(async () => {
  await check()
  if (authenticated.value) await router.push('/queues') // already signed in
})

async function submit() {
  if (busy.value) return
  busy.value = true
  const ok = await login(password.value)
  busy.value = false
  if (ok) await router.push('/queues')
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-gray-50 p-4">
    <form
      class="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-sm"
      @submit.prevent="submit"
    >
      <h1 class="mb-1 text-lg font-semibold">
        Вход для оператора
      </h1>
      <p class="mb-5 text-sm text-gray-500">
        Служебная зона мониторинга импорта.
      </p>

      <p
        v-if="!enabled"
        class="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700"
      >
        Вход оператора отключён администратором.
      </p>

      <label
        for="op-password"
        class="mb-1 block text-sm font-medium text-gray-700"
      >Пароль</label>
      <input
        id="op-password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        placeholder="••••••••"
      >

      <p
        v-if="error"
        class="mt-2 text-sm text-red-600"
      >
        {{ error }}
      </p>

      <button
        type="submit"
        class="mt-5 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        :disabled="busy || !password"
      >
        {{ busy ? 'Вход…' : 'Войти' }}
      </button>
    </form>
  </div>
</template>
