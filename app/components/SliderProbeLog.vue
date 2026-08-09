<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatProbeEntry, probeOutcome, type ProbeEntry } from '~/utils/sliderProbe'

// Журнал стенда (#477): что нажали, когда вернулось управление и с чем.
//
// ⚠ Печатается НА ЭКРАНЕ, а не в консоль. Половина смысла стенда — мобильное приложение Битрикс24,
// где консоли нет вовсе; журнал в консоли отвечал бы на вопрос только там, где он и так почти
// понятен. Строки видно и на телефоне, и их можно переписать в задачу руками.

const entries = ref<ProbeEntry[]>([])
// ⚠ Часы КЛИЕНТСКИЕ и это сказано явно. Прежняя проверка `typeof performance === 'undefined'` была
// мёртвой: в Node 16+ `performance` глобален, то есть на пререндере брался бы отсчёт серверного
// процесса. Сегодня безвредно (список пуст до монтирования), но безвредно СЛУЧАЙНО.
const t0 = import.meta.client ? performance.now() : 0
const now = () => (import.meta.client ? performance.now() : 0)
let seq = 0

/** Идёт ли сейчас замер (кнопки на время замера гасятся). */
const busy = ref(false)
const running = computed(() => busy.value)

/**
 * Прогнать действие стенда и записать ОБА момента — клик и возврат управления.
 *
 * ⚠ Строка добавляется ДО вызова, со состоянием «ждём…», и дополняется после. Это и есть весь
 * смысл: если управление возвращается только после закрытия слайдера, строка будет висеть в «ждём…»
 * всё время, пока слайдер открыт, — и это видно глазами. При записи одной строкой ПОСЛЕ вызова обе
 * картины выглядели бы одинаково, отличаясь лишь числом, которое ещё надо истолковать.
 *
 * ⚠ Пока замер идёт, второй не начинается: два пути закрытия, запущенные вперехлёст, стреляют в
 * один и тот же канал сообщений фрейма — и испортили бы ровно то наблюдение, ради которого стенд
 * собран («какой путь закрыл и когда»).
 */
async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
  if (busy.value) return
  busy.value = true
  const entry: ProbeEntry = { id: ++seq, label, startedMs: now() - t0, elapsedMs: null, result: 'выполняется' }
  entries.value = [entry, ...entries.value]
  const started = now()
  try {
    const value = await fn()
    entry.result = probeOutcome(value, false)
  } catch (err) {
    entry.result = probeOutcome(null, true)
    // ⚠ На экран идёт КЛАСС исхода, а в консоль — подробность, и это не противоречие: у человека с
    // телефоном консоли нет, а у сидящего за компьютером она есть. Без этого следа отказ SDK
    // (переименовали метод) выглядел бы точно так же, как законный отказ портала, — то есть стенд
    // молча врал бы о причине.
    console.error('[slider-probe]', label, err)
  } finally {
    entry.elapsedMs = Math.round(now() - started)
    // Подменяем массив: сам объект мутируется, а список должен перерисоваться.
    entries.value = [...entries.value]
    busy.value = false
  }
}

defineExpose({ run, running })
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
      <!-- ⚠ Ключ — свой счётчик, а не индекс: строки добавляются В НАЧАЛО, поэтому индекс каждой
           уже существующей строки сдвигается на каждом клике. -->
      <li
        v-for="e in entries"
        :key="e.id"
        class="rounded bg-(--ui-color-base-8) px-2 py-1"
        :class="e.elapsedMs === null ? 'text-(--ui-color-accent-main-primary)' : ''"
      >
        {{ formatProbeEntry(e) }}
      </li>
    </ul>
  </div>
</template>
