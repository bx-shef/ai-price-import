<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAuth } from '~/composables/useAuth'
import { formatWait } from '~/utils/loginError'

// Operator sign-in (service zone). Layout `clear`, noindex, prerendered.
definePageMeta({ layout: 'clear' })
useHead({ title: 'Вход оператора', meta: [{ name: 'robots', content: 'noindex' }] })

const { login, error, enabled, retryIn, authenticated, check } = useAuth()
const router = useRouter()
const password = ref('')
const busy = ref(false)
// Пока сессия не проверена, `enabled` ещё true по умолчанию — гасить форму рано, иначе поле
// мигало бы неактивным на каждой загрузке.
const checked = ref(false)
/**
 * Вход выключен администратором — состояние терминальное, набирать пароль незачем.
 * Отдельно от блокировки за перебор: та временная, и гасит только кнопку (см. ниже).
 */
const loginOff = computed(() => checked.value && !enabled.value)
/** Кнопка недоступна: выключенный вход, идущий запрос, пустое поле или отсчёт после перебора. */
const submitBlocked = computed(() => loginOff.value || busy.value || !password.value || retryIn.value > 0)

onMounted(async () => {
  await check()
  checked.value = true
  if (authenticated.value) await router.push('/queues') // already signed in
})

async function submit() {
  if (submitBlocked.value) return
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
          v-if="loginOff"
          class="mb-4"
          color="air-primary-warning"
          variant="soft"
          title="Вход оператора отключён"
          description="Пароль оператора не задан в настройках сервера — обратитесь к администратору."
        />

        <!-- `error` в поле — ради aria: оно проставляет полю aria-invalid и aria-describedby, иначе
             сообщение висело бы рядом, никак с полем не связанное. Сам текст показывает алерт ниже
             (живая область: его читают и когда фокус ушёл). -->
        <B24FormField
          label="Пароль"
          :error="!!error"
          :help="loginOff ? 'Вход выключен: пароль оператора не задан на сервере.' : undefined"
        >
          <B24Input
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="••••••••"
            class="w-full"
            :disabled="loginOff"
            :autofocus="!loginOff"
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
          :disabled="submitBlocked"
          :label="busy ? 'Вход…' : retryIn > 0 ? `Повтор ${formatWait(retryIn)}` : 'Войти'"
        />
      </form>
    </B24Card>
  </div>
</template>
