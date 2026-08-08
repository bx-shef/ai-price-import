<script setup lang="ts">
// Журнал импортов на главной (#458): дела, которые приложение записало в таймлайн CRM.
//
// ПОЧЕМУ СВОЙ КОНТЕЙНЕР ПРОКРУТКИ, а не прокрутка страницы. Внутри портала приложение живёт в
// iframe с `fitWindow`: рамка подгоняется под высоту содержимого, и своей прокрутки у нас нет —
// скроллит РОДИТЕЛЬСКОЕ окно, до которого мы не дотягиваемся. Наблюдатель на «часовом» в конце
// списка в такой раскладке виден сразу весь и выстреливает на все страницы разом. `B24ScrollArea`
// с заданной высотой возвращает прокрутку нам — и это единственная раскладка, которая одинаково
// работает и во фрейме портала, и в мобильном приложении, где страница прокручивается пальцем.
//
// ⚠ Кнопка «Показать ещё» остаётся ВСЕГДА, а не только как запасной путь: автоподкачка не
// доступна с клавиатуры и не объявляется программами чтения — человек, не пользующийся мышью,
// иначе не смог бы добраться до второй страницы вовсе.
import { onMounted, useTemplateRef } from 'vue'
import { useInfiniteScroll } from '@vueuse/core'
import { formatJournalDate, journalOutcomeLabel, ownerOpenPath } from '~/utils/journalView'

const { rows, loading, hasMore, loadError, loaded, canLoadMore, load, retry, reload } = useImportJournal()

/**
 * Перечитать журнал с начала — зовёт страница после завершения импорта.
 *
 * ⚠ Без этого только что загруженный документ не появлялся бы в журнале до перезагрузки страницы:
 * человек видит «Готово» в списке текущей пачки и пустоту (или вчерашние строки) в журнале прямо
 * под ним — два блока об одном и том же противоречат друг другу на одном экране.
 */
defineExpose({ reload })

const scroller = useTemplateRef<{ $el?: HTMLElement }>('scroller')

onMounted(() => {
  void load()
  // ⚠ `distance` с запасом: подкачка должна начаться ДО того, как человек упрётся в конец, иначе
  // на медленной сети список замирает под пальцем. Само решение «пора ли» — в чистой
  // `shouldLoadMore`, здесь только повод спросить.
  useInfiniteScroll(
    () => scroller.value?.$el ?? null,
    () => {
      if (canLoadMore.value) void load()
    },
    { distance: 200 }
  )
})

/**
 * Открыть карточку, в которой лежит дело.
 *
 * ⚠ Это карточка-ВЛАДЕЛЕЦ: при найденном контрагенте — компания, а не созданная сделка. Путь
 * строит чистая `ownerOpenPath`, знающая про тип 4; собирать его здесь значило бы завести вторую
 * копию правила и однажды забыть про компанию.
 */
async function openOwner(ownerTypeId: number, ownerId: number): Promise<void> {
  const path = ownerOpenPath(ownerTypeId, ownerId)
  if (!path) return
  const { init, get } = useB24()
  await init()
  const frame = get()
  if (!frame) return
  try {
    await frame.slider.openPath(frame.slider.getUrl(path))
  } catch { /* слайдер не открылся — карточка доступна из таймлайна, тупика нет */ }
}
</script>

<template>
  <B24PageCard
    variant="outline"
    title="Журнал импортов"
    description="Загруженные вами документы и что с ними стало."
  >
    <!-- ⚠ До завершения первой попытки экран НЕ утверждает ничего: ни «пусто», ни список.
         Иначе человек с месяцем импортов на долю секунды читает «загрузок не было» (#408). -->
    <div
      v-if="!loaded"
      class="space-y-2"
      aria-hidden="true"
    >
      <B24Skeleton
        v-for="i in 4"
        :key="i"
        class="h-14 w-full"
      />
    </div>

    <B24Alert
      v-else-if="loadError && rows.length === 0"
      color="air-primary-alert"
      role="alert"
      :title="loadError"
    >
      <template #actions>
        <B24Button
          size="sm"
          color="air-secondary-no-accent"
          label="Повторить"
          @click="retry"
        />
      </template>
    </B24Alert>

    <p
      v-else-if="rows.length === 0"
      class="py-6 text-center text-sm text-(--ui-color-base-3)"
    >
      Вы ещё ничего не импортировали. Загрузите документ — он появится здесь.
    </p>

    <template v-else>
      <B24ScrollArea
        ref="scroller"
        class="max-h-[28rem]"
      >
        <ul class="space-y-2">
          <li
            v-for="row in rows"
            :key="row.activityId"
            class="flex items-center justify-between gap-3 rounded-lg border border-(--ui-color-base-5) bg-(--ui-color-base-7) p-3"
          >
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">
                {{ row.title }}
              </p>
              <p class="text-xs text-(--ui-color-base-3)">
                {{ formatJournalDate(row.createdAt) }}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <!-- ⚠ Исход подписан СЛОВАМИ, а не только цветом: цвет один не читается программой
                   чтения и не различается при дальтонизме. -->
              <B24Badge
                :color="row.clean ? 'air-primary-success' : 'air-primary-alert'"
                :label="journalOutcomeLabel(row.clean)"
              />
              <B24Button
                v-if="ownerOpenPath(row.ownerTypeId, row.ownerId)"
                size="xs"
                color="air-tertiary-no-accent"
                label="Открыть"
                @click="openOwner(row.ownerTypeId, row.ownerId)"
              />
            </div>
          </li>
        </ul>
      </B24ScrollArea>

      <!-- ⚠ Отказ ПОДКАЧКИ показывается под уже загруженным списком, а не вместо него: строки,
           которые человек читает, не должны исчезать из-за сбоя следующей страницы. -->
      <B24Alert
        v-if="loadError"
        class="mt-2"
        color="air-primary-alert"
        role="alert"
        :title="loadError"
      >
        <template #actions>
          <B24Button
            size="sm"
            color="air-secondary-no-accent"
            label="Повторить"
            @click="retry"
          />
        </template>
      </B24Alert>

      <B24Button
        v-else-if="hasMore"
        class="mt-2"
        block
        size="sm"
        color="air-secondary-no-accent"
        :loading="loading"
        label="Показать ещё"
        @click="load"
      />
    </template>
  </B24PageCard>
</template>
