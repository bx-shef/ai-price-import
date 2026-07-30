<script setup lang="ts">
import { computed, onMounted, ref, useTemplateRef } from 'vue'
import { useAuth } from '~/composables/useAuth'

// Operator sign-in (service zone). Layout `clear`, noindex, prerendered.
definePageMeta({ layout: 'clear' })
useHead({ title: 'Вход оператора', meta: [{ name: 'robots', content: 'noindex' }] })

const { login, error, enabled, lockedOut, authenticated, check } = useAuth()
const router = useRouter()
const password = ref('')
const busy = ref(false)
// Пока сессия не проверена, `enabled` ещё true по умолчанию — блокировать форму рано, иначе поле
// мигало бы неактивным на каждой загрузке.
const checked = ref(false)
/** Форма неактивна: вход выключен администратором или сработала защита от перебора (#271-M). */
const formDisabled = computed(() => (checked.value && !enabled.value) || lockedOut.value)
const passwordField = useTemplateRef<{ inputRef?: HTMLInputElement }>('passwordField')

onMounted(async () => {
  await check()
  checked.value = true
  if (authenticated.value) {
    await router.push('/queues') // already signed in
    return
  }
  // Курсор сразу в поле: на этой странице ровно одно действие, и заставлять целиться мышью незачем.
  if (!formDisabled.value) passwordField.value?.inputRef?.focus()
})

async function submit() {
  if (busy.value || formDisabled.value) return
  busy.value = true
  const ok = await login(password.value)
  busy.value = false
  if (ok) await router.push('/queues')
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-4">
    <B24Card
      variant="outline"
      class="w-full max-w-sm"
    >
      <form @submit.prevent="submit">
        <h1 class="mb-1 text-lg font-semibold">
          Вход для оператора
        </h1>
        <p class="mb-5 text-sm text-(--ui-color-base-3)">
          Служебная зона мониторинга импорта.
        </p>

        <B24Alert
          v-if="checked && !enabled"
          class="mb-4"
          color="air-primary-warning"
          title="Вход оператора отключён администратором."
          description="Пароль оператора не задан в настройках сервера — войти нельзя, пока его не пропишет администратор."
        />

        <B24FormField label="Пароль">
          <B24Input
            ref="passwordField"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="••••••••"
            class="w-full"
            :disabled="formDisabled"
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
          :disabled="busy || !password || formDisabled"
          :label="busy ? 'Вход…' : 'Войти'"
        />
      </form>
    </B24Card>
  </div>
</template>
