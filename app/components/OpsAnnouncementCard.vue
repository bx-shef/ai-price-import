<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Announcement } from '~/utils/announcement'
import {
  DEFAULT_ANNOUNCEMENT_DAYS, MAX_ANNOUNCEMENT_CTA, MAX_ANNOUNCEMENT_IMAGE_BYTES,
  MAX_ANNOUNCEMENT_TEXT, MAX_ANNOUNCEMENT_TITLE
} from '~/config/announcement'

// Консоль оператора: объявление клиентам (#469).
//
// Отправка — действие БЕЗ ОТКАТА: окно, которое сотрудник уже открыл, не отзывается. Поэтому здесь
// два шага — «Проверить» (сервер валидирует и показывает, что именно уедет) и только потом
// «Отправить всем», и подтверждение дублируется НА СЕРВЕРЕ: кнопка исчезает вместе с вкладкой,
// а роут остаётся.
//
// ⚠ Картинка кладётся файлом и превращается в base64 ЗДЕСЬ — сервер хранит её внутри объявления
// (решение владельца). Файлового хранилища у приложения нет, и заводить его ради баннера не стали.

const draft = ref({
  title: '',
  text: '',
  image: '',
  linkUrl: '',
  linkLabel: '',
  days: DEFAULT_ANNOUNCEMENT_DAYS
})

const current = ref<Announcement | null>(null)
const preview = ref<Announcement | null>(null)
const problems = ref<string[]>([])
const message = ref('')
const busy = ref(false)
const imageName = ref('')

const canSend = computed(() => !!preview.value && !busy.value)

async function loadCurrent(): Promise<void> {
  try {
    const r = await $fetch<{ announcement?: Announcement | null }>('/api/ops/announcement')
    current.value = r?.announcement ?? null
  } catch {
    current.value = null
  }
}
void loadCurrent()

/** Файл → base64. Кап проверяет и сервер; здесь он ради внятного отказа до отправки. */
function onImage(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  imageName.value = file.name
  if (file.size > MAX_ANNOUNCEMENT_IMAGE_BYTES) {
    problems.value = [`картинка ${Math.round(file.size / 1024)} КБ — больше ${Math.round(MAX_ANNOUNCEMENT_IMAGE_BYTES / 1024)} КБ`]
    draft.value.image = ''
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    draft.value.image = String(reader.result ?? '')
    preview.value = null // содержимое изменилось — прежний предпросмотр больше не про него
  }
  reader.readAsDataURL(file)
}

async function send(action: 'preview' | 'publish' | 'clear'): Promise<void> {
  busy.value = true
  problems.value = []
  message.value = ''
  try {
    const r = await $fetch<{ preview?: Announcement, announcement?: Announcement, cleared?: boolean }>(
      '/api/ops/announcement',
      { method: 'POST', body: { action, draft: draft.value, confirm: action === 'publish' } }
    )
    if (action === 'preview') {
      preview.value = r?.preview ?? null
      message.value = 'Проверено. Ниже — то, что увидят сотрудники.'
    } else if (action === 'publish') {
      current.value = r?.announcement ?? null
      preview.value = null
      message.value = 'Отправлено. Каждый сотрудник увидит объявление один раз.'
    } else {
      current.value = null
      message.value = 'Объявление снято — новым сотрудникам оно больше не покажется.'
    }
  } catch (e) {
    const data = (e as { data?: { error?: string, problems?: string[] } })?.data
    problems.value = data?.problems ?? [data?.error ?? 'не удалось выполнить']
    if (action !== 'preview') preview.value = null
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mt-8">
    <h2 class="mb-1 text-sm font-semibold text-(--ui-color-base-2)">
      Объявление клиентам
    </h2>
    <p class="mb-3 text-xs text-(--ui-color-base-4)">
      Уходит всем порталам сразу. Каждый сотрудник увидит его один раз — на компьютере окном, на
      телефоне шторкой. Закрытое объявление он больше не увидит, поэтому текст должен читаться
      с первого раза.
    </p>

    <B24Alert
      v-if="current"
      class="mb-3"
      color="air-primary-success"
      size="sm"
      :title="`Сейчас показывается: ${current.title}`"
      :description="`До ${new Date(current.expiresAt).toLocaleDateString('ru-RU')}`"
    />

    <div class="space-y-3 rounded-xl border border-(--ui-color-base-5) p-3">
      <B24Input
        v-model="draft.title"
        placeholder="Заголовок"
        :maxlength="MAX_ANNOUNCEMENT_TITLE"
      />
      <B24Textarea
        v-model="draft.text"
        placeholder="Текст объявления"
        :rows="4"
        :maxlength="MAX_ANNOUNCEMENT_TEXT"
      />
      <div class="flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          class="text-xs"
          @change="onImage"
        >
        <span
          v-if="imageName"
          class="text-xs text-(--ui-color-base-4)"
        >{{ imageName }}</span>
      </div>
      <div class="flex flex-wrap gap-2">
        <B24Input
          v-model="draft.linkUrl"
          class="min-w-60 flex-1"
          placeholder="Ссылка кнопки (https://…), необязательно"
        />
        <B24Input
          v-model="draft.linkLabel"
          class="min-w-40"
          placeholder="Подпись кнопки"
          :maxlength="MAX_ANNOUNCEMENT_CTA"
        />
        <B24Input
          v-model.number="draft.days"
          class="w-28"
          type="number"
          placeholder="Дней"
        />
      </div>

      <ul
        v-if="problems.length"
        class="list-inside list-disc text-xs text-(--ui-color-accent-main-alert)"
      >
        <li
          v-for="p in problems"
          :key="p"
        >
          {{ p }}
        </li>
      </ul>
      <p
        v-if="message"
        class="text-xs text-(--ui-color-base-3)"
        role="status"
      >
        {{ message }}
      </p>

      <!-- Предпросмотр строит СЕРВЕР той же функцией, что и публикация: свой рендер здесь показал бы
           не то, что уедет клиентам, — а это ровно та ошибка, которую два шага и должны исключить. -->
      <div
        v-if="preview"
        class="rounded-lg bg-(--ui-color-base-8) p-3"
      >
        <p class="text-sm font-semibold">
          {{ preview.title }}
        </p>
        <img
          v-if="preview.image"
          :src="preview.image"
          alt=""
          class="my-2 max-h-40 rounded"
        >
        <p class="whitespace-pre-line text-xs text-(--ui-color-base-3)">
          {{ preview.text }}
        </p>
        <p
          v-if="preview.linkUrl"
          class="mt-2 text-xs text-(--ui-color-base-4)"
        >
          Кнопка «{{ preview.linkLabel }}» → {{ preview.linkUrl }}
        </p>
      </div>

      <div class="flex flex-wrap gap-2">
        <B24Button
          label="Проверить"
          color="air-secondary"
          :disabled="busy"
          @click="send('preview')"
        />
        <B24Button
          label="Отправить всем"
          color="air-primary"
          :disabled="!canSend"
          @click="send('publish')"
        />
        <B24Button
          v-if="current"
          label="Снять объявление"
          color="air-tertiary-no-accent"
          :disabled="busy"
          @click="send('clear')"
        />
      </div>
    </div>
  </div>
</template>
