<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Announcement } from '~/utils/announcement'
import { deliveryNote } from '~/utils/announcementDelivery'
import {
  DEFAULT_ANNOUNCEMENT_DAYS, MAX_ANNOUNCEMENT_CTA, MAX_ANNOUNCEMENT_DAYS,
  MAX_ANNOUNCEMENT_IMAGE_BYTES, MAX_ANNOUNCEMENT_TEXT, MAX_ANNOUNCEMENT_TITLE
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

// ⚠ Работа с объявлением живёт в ПАНЕЛИ (#473 п.7): форма из шести полей, предпросмотр и три кнопки
// занимали страницу, которая нужна для наблюдения за очередями. На самой странице остаётся строка
// состояния и кнопка — чтобы видеть, что сейчас показывается, не открывая ничего.
const panel = ref(false)

/** Каким носителем показать предпросмотр: оба вида проверяются, а не тот, что достался по ширине. */
const previewAs = ref<'modal' | 'sheet'>('modal')
/** Предпросмотр показан поверх панели. Закрывается кнопкой самого объявления. */
const showPreview = ref(false)

/** Сколько знаков осталось. Показываем только когда предел близко — иначе это шум. */
function left(value: string, max: number): number {
  return max - value.length
}

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
    const r = await $fetch<{
      preview?: Announcement
      announcement?: Announcement
      cleared?: boolean
      broadcast?: { total: number, sent: number, failed: number, truncated: boolean } | null
    }>(
      '/api/ops/announcement',
      { method: 'POST', body: { action, draft: draft.value, confirm: action === 'publish' } }
    )
    if (action === 'preview') {
      preview.value = r?.preview ?? null
      message.value = 'Проверено. Ниже — то, что увидят сотрудники.'
    } else if (action === 'publish') {
      current.value = r?.announcement ?? null
      preview.value = null
      message.value = `Отправлено. Каждый сотрудник увидит объявление один раз. ${deliveryNote(r?.broadcast)}`
    } else {
      current.value = null
      message.value = `Объявление снято — новым сотрудникам оно больше не покажется. ${deliveryNote(r?.broadcast)}`
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

    <!-- На странице — только состояние и вход. Всё остальное в панели (#473 п.7). -->
    <div class="flex flex-wrap items-center gap-3">
      <B24Alert
        v-if="current"
        class="flex-1"
        color="air-primary-success"
        size="sm"
        :title="`Сейчас показывается: ${current.title}`"
        :description="`До ${new Date(current.expiresAt).toLocaleDateString('ru-RU')}`"
      />
      <p
        v-else
        class="flex-1 text-xs text-(--ui-color-base-4)"
      >
        Сейчас объявления нет.
      </p>
      <B24Button
        label="Объявление"
        color="air-secondary"
        @click="() => { panel = true }"
      />
    </div>

    <B24Slideover
      :open="panel"
      title="Объявление клиентам"
      description="Уходит всем порталам сразу и показывается каждому сотруднику один раз."
      @update:open="v => panel = v"
    >
      <template #body>
        <div class="space-y-4">
          <!-- ⚠ У КАЖДОГО поля своё НАЗВАНИЕ и подсказка (#473 п.5). Прежде подписью служил
               `placeholder`, а он исчезает, как только в поле что-то введено: назначение поля
               пропадало вместе с ним. Хуже всех было узкое поле «Дней» — увидев в нём `14`,
               догадаться, что это срок показа, нельзя. Placeholder остался, но как ПРИМЕР
               значения, а не имя поля. -->
          <B24FormField
            label="Заголовок"
            description="Его читают первым и целиком — он же становится шапкой окна."
            required
          >
            <B24Input
              v-model="draft.title"
              class="w-full"
              placeholder="Например: Плановые работы 15 августа"
              :maxlength="MAX_ANNOUNCEMENT_TITLE"
            />
            <template
              v-if="left(draft.title, MAX_ANNOUNCEMENT_TITLE) <= 20"
              #hint
            >
              осталось {{ left(draft.title, MAX_ANNOUNCEMENT_TITLE) }}
            </template>
          </B24FormField>

          <B24FormField
            label="Текст объявления"
            description="Абзацы — пустой строкой. Можно **жирный**, списки через «- » и ссылки [текст](https://…) — остальная разметка выводится текстом. Проверьте кнопкой «Проверить»."
            required
          >
            <B24Textarea
              v-model="draft.text"
              class="w-full"
              placeholder="Что произошло и что человеку с этим делать"
              :rows="5"
              :maxlength="MAX_ANNOUNCEMENT_TEXT"
            />
            <template
              v-if="left(draft.text, MAX_ANNOUNCEMENT_TEXT) <= 80"
              #hint
            >
              осталось {{ left(draft.text, MAX_ANNOUNCEMENT_TEXT) }}
            </template>
          </B24FormField>

          <B24FormField
            label="Картинка"
            :description="`Необязательно. Только png, jpeg, webp или gif, не больше ${Math.round(MAX_ANNOUNCEMENT_IMAGE_BYTES / 1024)} КБ. SVG не принимаем — это документ со скриптами.`"
          >
            <div class="flex flex-wrap items-center gap-2">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                class="text-xs"
                aria-label="Картинка объявления"
                @change="onImage"
              >
              <span
                v-if="imageName"
                class="text-xs text-(--ui-color-base-4)"
              >{{ imageName }}</span>
            </div>
          </B24FormField>

          <B24FormField
            label="Ссылка кнопки"
            description="Необязательно, только https://. Без подписи кнопки объявление не опубликуется."
          >
            <B24Input
              v-model="draft.linkUrl"
              class="w-full"
              placeholder="https://example.com/акция"
            />
          </B24FormField>

          <B24FormField
            label="Подпись кнопки"
            description="Что написано на кнопке. Нужна, если задана ссылка."
          >
            <B24Input
              v-model="draft.linkLabel"
              class="w-full"
              placeholder="Например: Посмотреть"
              :maxlength="MAX_ANNOUNCEMENT_CTA"
            />
          </B24FormField>

          <B24FormField
            label="Сколько дней показывать"
            :description="`Не больше ${MAX_ANNOUNCEMENT_DAYS} дней: объявление — это новость, а не постоянная часть интерфейса.`"
          >
            <B24Input
              v-model.number="draft.days"
              class="w-32"
              type="number"
              :placeholder="String(DEFAULT_ANNOUNCEMENT_DAYS)"
            />
          </B24FormField>

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

          <!-- ⚠ Предпросмотр — НАСТОЯЩЕЕ объявление тем же компонентом, что увидит сотрудник
               (#473 п.4), с данными, собранными СЕРВЕРОМ той же функцией, что и публикация. Свой
               рендер здесь показывал бы не то, что уедет клиентам, — а это ровно та ошибка, которую
               два шага и должны исключить. Носитель выбирается руками, потому что оператор сидит за
               компьютером, а половина адресатов увидит шторку, и проверить её иначе негде. -->
          <div
            v-if="preview"
            class="flex flex-wrap items-center gap-2 rounded-lg bg-(--ui-color-base-8) p-3"
          >
            <span class="text-xs text-(--ui-color-base-3)">Посмотреть, как увидит сотрудник:</span>
            <B24Button
              label="Окном (компьютер)"
              color="air-tertiary-no-accent"
              size="xs"
              @click="() => { previewAs = 'modal'; showPreview = true }"
            />
            <B24Button
              label="Шторкой (телефон)"
              color="air-tertiary-no-accent"
              size="xs"
              @click="() => { previewAs = 'sheet'; showPreview = true }"
            />
          </div>
        </div>
      </template>

      <template #footer>
        <div class="flex flex-wrap gap-2">
          <B24Button
            label="Проверить"
            color="air-secondary"
            :disabled="busy"
            @click="send('preview')"
          />
          <B24Button
            label="Отправить всем"
            color="air-primary-alert"
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
      </template>
    </B24Slideover>

    <AnnouncementDialog
      v-if="showPreview && preview"
      :preview="preview"
      :preview-as="previewAs"
      @close="showPreview = false"
    />
  </div>
</template>
