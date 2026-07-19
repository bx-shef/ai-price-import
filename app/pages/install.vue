<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import type { B24Frame } from '@bitrix24/b24jssdk'
import { useB24 } from '~/composables/useB24'
import { B24_BOUND_EVENTS, B24_EVENT_HANDLER_PATH, B24_REQUIRED_SCOPES } from '~/config/b24'
import { buildEventBindCalls, isBindableHandlerUrl, type EventBinding } from '~/utils/b24EventBind'
import { LANDING_TITLE } from '~/utils/landing'
import { shortSha, commitUrl } from '~/utils/build'

// B24 install handler (Marketplace field «Путь к обработчику установки»). Runs INSIDE the
// portal iframe during install: registers the server-event handlers (ONAPPINSTALL /
// ONAPPUNINSTALL → backend /api/b24/events) BEFORE installFinish, so the current install's
// ONAPPINSTALL — which carries application_token + OAuth creds — is delivered to the backend.
// Prerendered (nitro.prerender.routes) so a HEAD request returns 200 for B24's URL check.
// Opened standalone (not in a portal) → redirects to the landing.
definePageMeta({ layout: 'clear' })
useHead({ title: `Установка — ${LANDING_TITLE}` })

const router = useRouter()
const b24 = useB24()
const frame = ref<B24Frame | null>(null)
const inFrame = computed(() => !!frame.value)

// Public URL the app is served from (NUXT_PUBLIC_SITE_URL in prod). In dev it isn't known
// ahead of time, so derive it from this install URL by stripping the trailing `/install`.
// The backend events endpoint is same origin (`/api/*` proxied to backend).
const config = useRuntimeConfig()
const stripTrailing = (u: string) => u.replace(/\/+$/, '')
const configuredSiteUrl = stripTrailing((config.public.siteUrl as string) || '')

// Build commit (footer «сборка <sha>» → GitHub, same as the landing) + diagnostics modal state.
const buildSha = computed(() => shortSha(config.public.commitSha as string))
const buildHref = computed(() => commitUrl(config.public.commitSha as string))
const diagOpen = ref(false)
const appUrl = import.meta.dev && typeof window !== 'undefined'
  ? stripTrailing(`${window.location.origin}${window.location.pathname.replace(/\/install\/?$/, '')}`)
  : configuredSiteUrl
const eventHandlerUrl = computed(() => (appUrl ? `${appUrl}${B24_EVENT_HANDLER_PATH}` : ''))

const progressColor = ref<'air-primary' | 'air-primary-success' | 'air-primary-warning' | 'air-primary-alert'>('air-primary')
const progressValue = ref<null | number>(null)
const installError = ref('')
const isRunning = ref(false)
const caption = ref('Инициализация…')

interface InitData {
  appInfo?: { ID?: number, CODE?: string, VERSION?: string }
  scope?: string[]
  eventList?: EventBinding[]
}
const initData = ref<InitData>({})

const diagnostics = computed(() => {
  const granted = initData.value.scope ?? []
  const missing = B24_REQUIRED_SCOPES.filter(s => !granted.includes(s))
  let domain = ''
  let memberId = ''
  if (frame.value) {
    const auth = frame.value.auth.getAuthData()
    if (auth !== false) {
      domain = auth.domain
      memberId = auth.member_id || ''
    }
  }
  return {
    mode: inFrame.value ? 'B24 frame' : 'Standalone',
    domain,
    memberId,
    eventHandler: eventHandlerUrl.value || '—',
    appInfo: initData.value.appInfo,
    granted,
    missing,
    events: initData.value.eventList ?? []
  }
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Bind the server-event handlers to the backend endpoint. Idempotent: re-installs skip
 *  already-correct bindings and re-point stale ones. Must run before installFinish. */
async function bindEvents($b24: B24Frame): Promise<void> {
  // A relative/empty handler URL would register a dead binding B24 could never reach.
  if (!isBindableHandlerUrl(eventHandlerUrl.value)) {
    throw new Error(`Обработчик событий не абсолютный (${eventHandlerUrl.value || 'пусто'}). Задайте NUXT_PUBLIC_SITE_URL при сборке.`)
  }

  const existing = initData.value.eventList ?? []
  const { unbind, bind } = buildEventBindCalls(existing, B24_BOUND_EVENTS, eventHandlerUrl.value)

  if (unbind.length) await $b24.actions.v2.batch.make({ calls: unbind, options: { isHaltOnError: false } })

  if (bind.length) {
    const res = await $b24.actions.v2.batch.make({ calls: bind })
    if (!res.isSuccess) throw new Error(`event.bind не удался: ${res.getErrorMessages().join('; ')}`)
  }
}

async function runInstall() {
  if (isRunning.value) return
  isRunning.value = true
  installError.value = ''
  progressColor.value = 'air-primary'
  progressValue.value = null
  try {
    const $b24 = await b24.init()
    frame.value = $b24

    if (!$b24) {
      // Opened directly (not in a portal) — send the visitor to the landing.
      caption.value = 'Вне портала Bitrix24 — перенаправление…'
      progressColor.value = 'air-primary-warning'
      progressValue.value = 99
      await sleep(1200)
      await router.replace('/')
      return
    }

    caption.value = 'Запрос данных портала…'
    await $b24.parent.setTitle('Установка приложения')

    // Read-only diagnostics: app metadata + granted scopes + current event bindings.
    const response = await $b24.actions.v2.batch.make({
      calls: {
        appInfo: { method: 'app.info' },
        scope: { method: 'scope' },
        eventList: { method: 'event.get' }
      }
    })
    initData.value = response.getData() as InitData

    caption.value = 'Регистрация обработчика событий…'
    await bindEvents($b24)

    caption.value = 'Завершение установки…'
    progressColor.value = 'air-primary-success'
    progressValue.value = 100
    await sleep(600)
    await $b24.installFinish()
    caption.value = 'Готово'
  } catch (error: unknown) {
    console.error('[install]', error)
    progressColor.value = 'air-primary-alert'
    installError.value = error instanceof Error ? error.message : String(error)
  } finally {
    isRunning.value = false
  }
}

onMounted(runInstall)
</script>

<template>
  <div class="flex min-h-screen flex-col items-center justify-center gap-4 p-4">
    <div class="flex w-full max-w-2xl flex-col items-center gap-4">
      <h1 class="text-center text-2xl font-bold text-(--ui-color-base-1)">
        {{ LANDING_TITLE }}
      </h1>

      <B24Progress
        v-model="progressValue"
        size="xs"
        :color="progressColor"
        class="w-1/2"
      />

      <div
        v-if="installError"
        class="flex flex-col items-center gap-2 text-center"
      >
        <p class="text-sm font-medium text-(--ui-color-accent-main-alert)">
          Ошибка установки
        </p>
        <p class="max-w-md break-all text-xs text-(--ui-color-base-3)">
          {{ installError }}
        </p>
        <B24Button
          label="Повторить"
          color="air-primary"
          size="sm"
          :disabled="isRunning"
          @click="runInstall"
        />
      </div>
      <p
        v-else
        class="text-sm text-(--ui-color-base-3)"
      >
        {{ caption }}
      </p>
    </div>

    <!-- Bottom-right corner: build commit (like the landing footer) + a diagnostics modal trigger.
         Kept out of the main flow — install runs headless and B24 reloads the frame on finish, so
         diagnostics are a support aid, not part of the flow. -->
    <div class="fixed bottom-3 right-3 z-10 flex items-center gap-3 text-xs">
      <a
        :href="buildHref"
        target="_blank"
        rel="noopener noreferrer"
        class="font-mono text-(--ui-color-base-4) hover:text-(--ui-color-base-1) hover:underline"
      >сборка {{ buildSha || 'dev' }}</a>
      <B24Modal
        v-model:open="diagOpen"
        title="Диагностика (для техподдержки)"
      >
        <B24Button
          label="Диагностика"
          color="air-tertiary-no-accent"
          size="xs"
        />

        <template #body>
          <div class="flex flex-col gap-3 font-mono text-sm">
            <div class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
              <span class="text-(--ui-color-base-3)">Режим:</span>
              <span>{{ diagnostics.mode }}</span>
              <span class="text-(--ui-color-base-3)">Домен:</span>
              <span>{{ diagnostics.domain || '—' }}</span>
              <span class="text-(--ui-color-base-3)">member_id:</span>
              <span class="break-all">{{ diagnostics.memberId || '—' }}</span>
              <span class="text-(--ui-color-base-3)">Обработчик событий:</span>
              <span class="break-all">{{ diagnostics.eventHandler }}</span>
              <template v-if="diagnostics.appInfo">
                <span class="text-(--ui-color-base-3)">App:</span>
                <span>{{ diagnostics.appInfo.CODE }} (id {{ diagnostics.appInfo.ID }}, v{{ diagnostics.appInfo.VERSION }})</span>
              </template>
            </div>

            <div
              v-if="diagnostics.granted.length || diagnostics.missing.length"
              class="flex flex-col gap-1"
            >
              <span class="text-(--ui-color-base-3)">Права:</span>
              <div class="flex flex-wrap gap-1">
                <B24Badge
                  v-for="s in diagnostics.granted"
                  :key="`g-${s}`"
                  :label="s"
                  color="air-primary-success"
                  size="sm"
                />
                <B24Badge
                  v-for="s in diagnostics.missing"
                  :key="`m-${s}`"
                  :label="`${s} (нет)`"
                  color="air-primary-alert"
                  size="sm"
                />
              </div>
            </div>

            <div class="flex flex-col gap-1">
              <span class="text-(--ui-color-base-3)">События:</span>
              <div
                v-if="diagnostics.events.length === 0"
                class="italic text-(--ui-color-base-3)"
              >
                нет привязок
              </div>
              <ul
                v-else
                class="m-0 flex list-none flex-col gap-1 p-0"
              >
                <li
                  v-for="(e, i) in diagnostics.events"
                  :key="i"
                  class="break-all"
                >
                  <strong>{{ e.event }}</strong> → {{ e.handler }}
                </li>
              </ul>
            </div>
          </div>
        </template>
      </B24Modal>
    </div>
  </div>
</template>
