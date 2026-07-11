<script setup lang="ts">
import { computed, ref } from 'vue'
import { extractDemo, type DemoResult } from '~/utils/demoExtract'

// Public landing tryout: attach a document → see who the supplier is + goods table.
// Built-in samples parse client-side (instant, no rate-limit) via the same pure core;
// user uploads go through POST /api/demo/extract (rate-limited 3/10min + publicity note).
// Design/texts are placeholder — logic-first per product owner.

interface Sample { id: string, label: string, lang: string }
const SAMPLES: Sample[] = [
  { id: 'kp-ru', label: 'КП', lang: 'RU' },
  { id: 'invoice-ru', label: 'Счёт', lang: 'RU' },
  { id: 'ttn-ru', label: 'ТТН', lang: 'RU' },
  { id: 'kp-be', label: 'КП', lang: 'BY' },
  { id: 'invoice-be', label: 'Счёт', lang: 'BY' },
  { id: 'ttn-be', label: 'ТТН', lang: 'BY' },
  { id: 'kp-kk', label: 'Ұсыныс', lang: 'KZ' },
  { id: 'invoice-kk', label: 'Шот', lang: 'KZ' },
  { id: 'ttn-kk', label: 'Жүкқұжат', lang: 'KZ' }
]

const result = ref<DemoResult | null>(null)
const error = ref('')
const loading = ref(false)
const notice = ref('')
const sourceName = ref('')

const totalPairs = computed(() => {
  const t = result.value?.totals
  if (!t) return [] as Array<{ k: string, v: number }>
  const out: Array<{ k: string, v: number }> = []
  if (t.sum !== undefined) out.push({ k: 'Итого', v: t.sum })
  if (t.vat !== undefined) out.push({ k: 'НДС', v: t.vat })
  if (t.total !== undefined) out.push({ k: 'Всего к оплате', v: t.total })
  return out
})

async function runSample(s: Sample) {
  error.value = ''
  notice.value = ''
  loading.value = true
  try {
    const text = await $fetch<string>(`/demo/${s.id}.txt`, { responseType: 'text' })
    result.value = extractDemo(text)
    sourceName.value = `${s.label} (${s.lang}) — пример`
  } catch {
    error.value = 'Не удалось загрузить пример.'
    result.value = null
  } finally {
    loading.value = false
  }
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  await upload(file)
  input.value = '' // allow re-selecting the same file
}

async function upload(file: File) {
  error.value = ''
  notice.value = ''
  loading.value = true
  result.value = null
  try {
    const fd = new FormData()
    fd.append('file', file)
    const res = await $fetch<{ result?: DemoResult, notice?: string, error?: string }>(
      '/api/demo/extract',
      { method: 'POST', body: fd }
    )
    if (res.error || !res.result) {
      error.value = res.error || 'Не удалось разобрать файл.'
    } else {
      result.value = res.result
      notice.value = res.notice || ''
      sourceName.value = file.name
    }
  } catch (err: unknown) {
    const data = (err as { data?: { error?: string } })?.data
    error.value = data?.error || 'Ошибка обработки. Для демо подойдёт текст (.txt/.csv) или Excel (.xlsx).'
  } finally {
    loading.value = false
  }
}

const dragOver = ref(false)
async function onDrop(e: DragEvent) {
  dragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) await upload(file)
}

const money = (n: number) => n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
</script>

<template>
  <div class="mx-auto max-w-3xl">
    <!-- Samples -->
    <p class="mb-3 text-sm text-slate-400">
      Попробуйте на примере (РФ / РБ / Казахстан) — можно и скачать:
    </p>
    <div class="mb-6 flex flex-wrap gap-2">
      <span
        v-for="s in SAMPLES"
        :key="s.id"
        class="inline-flex items-stretch overflow-hidden rounded-lg border border-white/10 bg-white/[0.04]"
      >
        <button
          type="button"
          class="px-3 py-1.5 text-sm text-slate-200 transition hover:bg-cyan-400/10"
          @click="runSample(s)"
        >
          {{ s.label }} <span class="text-slate-500">{{ s.lang }}</span>
        </button>
        <a
          :href="`/demo/${s.id}.txt`"
          :download="`${s.id}.txt`"
          class="flex items-center border-l border-white/10 px-2 text-slate-500 transition hover:bg-cyan-400/10 hover:text-cyan-300"
          :aria-label="`Скачать пример: ${s.label} (${s.lang})`"
          :title="`Скачать пример (${s.lang})`"
        >
          <svg
            class="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
          </svg>
        </a>
      </span>
    </div>

    <!-- Dropzone -->
    <label
      class="flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-10 text-center transition"
      :class="dragOver ? 'border-cyan-400 bg-cyan-400/10' : 'border-white/15 bg-white/[0.02] hover:border-cyan-400/40'"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
    >
      <span class="text-slate-300">Перетащите файл сюда или нажмите, чтобы выбрать</span>
      <span class="mt-1 text-xs text-slate-500">Для демо: текст (.txt/.csv) или Excel (.xlsx), до 1 МБ</span>
      <input
        type="file"
        accept=".txt,.csv,.tsv,.xlsx,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        class="hidden"
        @change="onFile"
      >
    </label>

    <p class="mt-3 text-xs text-amber-300/80">
      ⚠️ Демо публичное: не загружайте конфиденциальные документы. Ограничение — 3 файла за 10 минут.
    </p>

    <!-- Result -->
    <div
      v-if="loading"
      class="mt-6 text-center text-slate-400"
    >
      Разбираем…
    </div>
    <div
      v-else-if="error"
      class="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200"
    >
      {{ error }}
    </div>
    <div
      v-else-if="result"
      class="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-left"
    >
      <div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span class="rounded-full bg-cyan-500/15 px-2.5 py-0.5 text-xs font-medium text-cyan-300 ring-1 ring-cyan-400/30">
            {{ result.docTypeLabel }}
          </span>
          <span
            v-if="result.number"
            class="ml-2 text-sm text-slate-400"
          >№ {{ result.number }}</span>
          <span
            v-if="result.date"
            class="ml-1 text-sm text-slate-500"
          >от {{ result.date }}</span>
        </div>
        <span class="text-xs text-slate-500">{{ sourceName }}</span>
      </div>

      <div class="mb-4">
        <div class="text-xs uppercase tracking-wide text-slate-500">
          Подрядчик
        </div>
        <div class="text-slate-100">
          {{ result.supplier?.name || '—' }}
        </div>
        <div
          v-if="result.supplier?.taxId"
          class="text-sm text-slate-400"
        >
          {{ result.supplier?.taxIdKind }}: {{ result.supplier?.taxId }}
        </div>
      </div>

      <div
        v-if="result.items.length"
        class="overflow-x-auto"
      >
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-white/10 text-left text-slate-500">
              <th class="py-1.5 pr-3 font-medium">
                Наименование
              </th>
              <th class="py-1.5 pr-3 font-medium">
                Кол-во
              </th>
              <th class="py-1.5 pr-3 font-medium">
                Цена
              </th>
              <th class="py-1.5 font-medium">
                Сумма
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(it, i) in result.items"
              :key="i"
              class="border-b border-white/5"
            >
              <td class="py-1.5 pr-3 text-slate-200">
                {{ it.name }}<span
                  v-if="it.article"
                  class="ml-1 text-slate-500"
                >· {{ it.article }}</span>
              </td>
              <td class="py-1.5 pr-3 text-slate-300">
                {{ it.quantity ?? '—' }}<span
                  v-if="it.unit"
                  class="text-slate-500"
                > {{ it.unit }}</span>
              </td>
              <td class="py-1.5 pr-3 text-slate-300">
                {{ it.price !== undefined ? money(it.price) : '—' }}
              </td>
              <td class="py-1.5 text-slate-200">
                {{ it.sum !== undefined ? money(it.sum) : '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        v-if="totalPairs.length"
        class="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm"
      >
        <div
          v-for="p in totalPairs"
          :key="p.k"
        >
          <span class="text-slate-500">{{ p.k }}:</span>
          <span class="ml-1 text-slate-100">{{ money(p.v) }}</span>
        </div>
      </div>

      <ul
        v-if="result.warnings.length"
        class="mt-4 space-y-1 text-xs text-amber-300/80"
      >
        <li
          v-for="(w, i) in result.warnings"
          :key="i"
        >
          • {{ w }}
        </li>
      </ul>

      <p
        v-if="notice"
        class="mt-4 text-xs text-slate-500"
      >
        {{ notice }}
      </p>
    </div>
  </div>
</template>
