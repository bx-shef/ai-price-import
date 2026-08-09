<script setup lang="ts">
import { ref } from 'vue'
import { formatProbeEntry, probeOutcome, type ProbeEntry } from '~/utils/sliderProbe'

// Журнал стенда (#477): что нажали, когда вернулось управление и с чем.
//
// ⚠ Печатается НА ЭКРАНЕ, а не в консоль. Половина смысла стенда — мобильное приложение Битрикс24,
// где консоли нет вовсе; журнал в консоли отвечал бы на вопрос только там, где он и так почти
// понятен. Строки видно и на телефоне, и их можно переписать в задачу руками.

const entries = ref<ProbeEntry[]>([])
const t0 = typeof performance === 'undefined' ? 0 : performance.now()
const now = () => (typeof performance === 'undefined' ? 0 : performance.now())

/**
 * Прогнать действие стенда и записать ОБА момента — клик и возврат управления.
 *
 * ⚠ Строка добавляется ДО вызова, со состоянием «ждём…», и дополняется после. Это и есть весь
 * смысл: если управление возвращается только после закрытия слайдера, строка будет висеть в «ждём…»
 * всё время, пока слайдер открыт, — и это видно глазами. При записи одной строкой ПОСЛЕ вызова обе
 * картины выглядели бы одинаково, отличаясь лишь числом, которое ещё надо истолковать.
 */
async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
  const entry: ProbeEntry = { label, startedMs: now() - t0, elapsedMs: null, result: 'выполняется' }
  entries.value = [entry, ...entries.value]
  const started = now()
  try {
    const value = await fn()
    entry.result = probeOutcome(value, false)
  } catch {
    entry.result = probeOutcome(null, true)
  } finally {
    entry.elapsedMs = Math.round(now() - started)
    // Подменяем массив: сам объект мутируется, а список должен перерисоваться.
    entries.value = [...entries.value]
  }
}

defineExpose({ run })
</script>

<template>
  <div class="mt-4">
    <h3 class="mb-1 text-sm font-semibold">
      Что произошло
    </h3>
    <!-- ⚠ Пустое состояние объясняет, ЧТО тут появится: стенд открывают, чтобы понять поведение, и
         пустая рамка без подписи читается как поломка. -->
    <p
      v-if="!entries.length"
      class="text-xs text-(--ui-color-base-3)"
    >
      Нажмите кнопку — здесь появится время клика, время возврата управления и результат.
    </p>
    <ul
      v-else
      class="space-y-1 font-mono text-xs"
    >
      <li
        v-for="(e, i) in entries"
        :key="i"
        class="rounded bg-(--ui-color-base-8) px-2 py-1"
        :class="e.elapsedMs === null ? 'text-(--ui-color-accent-main-primary)' : ''"
      >
        {{ formatProbeEntry(e) }}
      </li>
    </ul>
  </div>
</template>
