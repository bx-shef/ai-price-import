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
import { computed, onMounted, useTemplateRef } from 'vue'
import { useInfiniteScroll } from '@vueuse/core'
import { journalDateTile, journalOutcomeLabel, ownerOpenPath } from '~/utils/journalView'

const { rows, loading, hasMore, loadError, loaded, canLoadMore, load, retry, reload } = useImportJournal()

/**
 * Перечитать журнал с начала — зовёт страница после завершения импорта.
 *
 * ⚠ Без этого только что загруженный документ не появлялся бы в журнале до перезагрузки страницы:
 * человек видит «Готово» в списке текущей пачки и пустоту (или вчерашние строки) в журнале прямо
 * под ним — два блока об одном и том же противоречат друг другу на одном экране.
 */
defineExpose({ reload })

/**
 * Строки для показа: к данным добавлена разобранная дата.
 *
 * ⚠ Считается ОДИН раз на строку, а не по вызову в разметке: плитка показывает три части одной
 * даты, и разбор в шаблоне выполнялся бы четырежды на каждую строку при каждой перерисовке —
 * на списке в сотню строк это заметно, а на телефоне заметно вдвойне.
 */
const view = computed(() => rows.value.map(row => ({ row, tile: journalDateTile(row.createdAt) })))

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
        <ul class="space-y-3">
          <!-- ⚠ Строка списка сделана ПО МОТИВАМ дела в таймлайне Битрикс24 (решение владельца,
               скриншот 08.08.2026): плитка-календарь слева, цветная метка исхода, поля подписанными
               блоками, действие ссылкой внизу. Копия «один в один» не нужна и была бы вредна —
               у нас нет ни чекбокса «выполнено», ни кнопок дела, и рисовать их значило бы обещать
               действия, которых здесь нет. -->
          <li
            v-for="{ row, tile } in view"
            :key="row.activityId"
            class="flex gap-3 rounded-lg border border-(--ui-color-base-5) bg-(--ui-color-base-8) p-3"
          >
            <!-- Плитка даты. ⚠ `aria-hidden`: то же время объявлено словами в подписи ниже, и без
                 этого программа чтения произносила бы «7 августа 20:28» дважды подряд. -->
            <div
              v-if="tile"
              class="flex w-14 shrink-0 flex-col items-center justify-center rounded-md bg-(--ui-color-base-7) py-1.5 text-center"
              aria-hidden="true"
            >
              <span class="text-lg leading-none font-semibold">{{ tile.day }}</span>
              <span class="mt-0.5 text-[10px] leading-tight text-(--ui-color-base-3)">{{ tile.month }}</span>
              <span class="mt-0.5 text-[10px] leading-none text-(--ui-color-base-3)">{{ tile.time }}</span>
            </div>

            <div class="min-w-0 flex-1">
              <div class="flex items-start justify-between gap-2">
                <p class="min-w-0 flex-1 truncate text-sm font-medium">
                  {{ row.title }}
                </p>
                <!-- ⚠ Исход подписан СЛОВАМИ, а не только цветом: цвет один не читается программой
                     чтения и не различается при дальтонизме. Цвета те же, что у самого дела в
                     портале, — человек видит на двух экранах одно и то же. -->
                <B24Badge
                  class="shrink-0"
                  size="xs"
                  :color="row.clean ? 'air-primary-success' : 'air-primary-alert'"
                  :label="journalOutcomeLabel(row.clean)"
                />
              </div>
              <p class="mt-0.5 text-xs text-(--ui-color-base-3)">
                <span class="sr-only">Загружено </span>{{ tile ? `${tile.day} ${tile.month}, ${tile.time}` : 'дата неизвестна' }}
              </p>
              <!-- Действие ссылкой, а не кнопкой: в деле портала оно выглядит так же, а кнопка в
                   каждой строке спорила бы за внимание с «Показать ещё» внизу списка. -->
              <button
                v-if="ownerOpenPath(row.ownerTypeId, row.ownerId)"
                type="button"
                class="mt-1.5 text-sm text-(--ui-color-accent-main-link) hover:underline"
                @click="openOwner(row.ownerTypeId, row.ownerId)"
              >
                Открыть карточку
              </button>
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
