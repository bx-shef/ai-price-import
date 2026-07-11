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

      <B24Alert
        v-if="!enabled"
        class="mb-4"
        color="air-primary-warning"
        title="Вход оператора отключён администратором."
      />

      <B24FormField label="Пароль">
        <B24Input
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="••••••••"
          class="w-full"
        />
      </B24FormField>

      <div aria-live="assertive">
        <B24Alert
          v-if="error"
          class="mt-2"
          color="air-primary-alert"
          :title="error"
        />
      </div>

      <B24Button
        type="submit"
        class="mt-5"
        color="air-primary"
        block
        :loading="busy"
        :disabled="busy || !password"
        :label="busy ? 'Вход…' : 'Войти'"
      />
    </form>
  </div>
</template>
