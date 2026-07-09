<script setup lang="ts">
import { onMounted } from 'vue'
import { useSettings } from '~/composables/useSettings'

// In-portal settings: per-portal mapping (P3 UI). Core fields — target entity, file
// saving, supplier-article field, product strategy. Layout `clear`, prerendered.
definePageMeta({ layout: 'clear' })
useHead({ title: 'Настройки импорта' })

const { mapping, loading, saving, saved, error, load, save } = useSettings()
onMounted(load)

const TARGET_PRESETS = [
  { id: 2, label: 'Сделка' },
  { id: 31, label: 'Смарт-счёт' },
  { id: 7, label: 'Коммерческое предложение' }
]
</script>

<template>
  <div class="mx-auto max-w-2xl p-4 sm:p-6">
    <h1 class="mb-1 text-xl font-semibold">
      Настройки импорта
    </h1>
    <p class="mb-5 text-sm text-gray-500">
      Куда и как приложение вносит товары из документов в вашем портале.
    </p>

    <p
      v-if="error"
      class="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700"
    >
      {{ error }}
    </p>

    <div
      class="space-y-6"
      :class="{ 'pointer-events-none opacity-50': loading }"
    >
      <!-- Целевая сущность -->
      <section>
        <label class="mb-1 block text-sm font-medium text-gray-700">Целевая сущность CRM</label>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="p in TARGET_PRESETS"
            :key="p.id"
            type="button"
            class="rounded-lg border px-3 py-1.5 text-sm transition-colors"
            :class="mapping.defaultTarget.entityTypeId === p.id ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-300 text-gray-600 hover:border-gray-400'"
            @click="mapping.defaultTarget.entityTypeId = p.id"
          >
            {{ p.label }}
          </button>
        </div>
        <div class="mt-2 flex items-center gap-2">
          <span class="text-xs text-gray-500">или ID типа (смарт-процесс ≥ 1000):</span>
          <input
            v-model.number="mapping.defaultTarget.entityTypeId"
            type="number"
            min="1"
            class="w-24 rounded-md border border-gray-300 px-2 py-1 text-sm"
          >
        </div>
      </section>

      <!-- Поле артикула поставщика -->
      <section>
        <label class="mb-1 block text-sm font-medium text-gray-700">Поле артикула поставщика</label>
        <input
          v-model="mapping.article.field"
          type="text"
          placeholder="например, PROPERTY_123 или свойство каталога"
          class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        >
        <div class="mt-2 flex gap-4 text-sm text-gray-600">
          <label class="flex items-center gap-1.5">
            <input
              v-model="mapping.article.kind"
              type="radio"
              value="text"
            > построчно (текст)
          </label>
          <label class="flex items-center gap-1.5">
            <input
              v-model="mapping.article.kind"
              type="radio"
              value="string"
            > через разделитель
          </label>
        </div>
        <input
          v-if="mapping.article.kind === 'string'"
          v-model="mapping.article.delimiter"
          type="text"
          placeholder="разделитель, например ;"
          class="mt-2 w-32 rounded-md border border-gray-300 px-2 py-1 text-sm"
        >
      </section>

      <!-- Стратегия товара -->
      <section>
        <label class="mb-1 block text-sm font-medium text-gray-700">Если товар не найден</label>
        <select
          v-model="mapping.product.onMissing"
          class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="skip-warn">
            Пропустить строку (предупреждение)
          </option>
          <option value="create">
            Создать товар в каталоге
          </option>
          <option value="freeform">
            Внести как произвольную позицию
          </option>
        </select>
      </section>

      <!-- Сохранение файла -->
      <section class="flex items-center justify-between">
        <div>
          <span
            id="savefile-label"
            class="block text-sm font-medium text-gray-700"
          >Сохранять исходный файл</span>
          <p class="text-xs text-gray-500">
            На общий Диск портала, в папку приложения по месяцам.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-labelledby="savefile-label"
          :aria-checked="mapping.saveFile"
          class="relative h-6 w-11 rounded-full transition-colors"
          :class="mapping.saveFile ? 'bg-blue-600' : 'bg-gray-300'"
          @click="mapping.saveFile = !mapping.saveFile"
        >
          <span
            class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform"
            :class="mapping.saveFile ? 'translate-x-5' : ''"
          />
        </button>
      </section>
    </div>

    <div class="mt-8 flex items-center gap-3">
      <button
        type="button"
        class="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        :disabled="saving || loading"
        @click="save"
      >
        {{ saving ? 'Сохранение…' : 'Сохранить' }}
      </button>
      <span
        v-if="saved"
        class="text-sm text-green-600"
      >Сохранено ✓</span>
    </div>
  </div>
</template>
