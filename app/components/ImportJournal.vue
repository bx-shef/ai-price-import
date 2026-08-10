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
import { computed, onMounted } from 'vue'
import { journalDateTile, journalOutcomeLabel, ownerOpenPath } from '~/utils/journalView'
import { activityOutcome } from '~/utils/activityBody'
import type { ImportJobView } from '~/composables/useImport'

// ⚠ ЖИВЫЕ строки приходят пропом, а не читаются здесь (#494). Источника два и они разной природы:
// идущий импорт живёт в статусе задания (Redis, часы), запись журнала — в ДЕЛЕ портала (сколько его
// там держат). Смешивать их в одном загрузчике значило бы связать сроки жизни двух хранилищ; здесь
// они только показываются вместе.
const props = withDefaults(defineProps<{
  live?: ImportJobView[]
  uploading?: boolean
  /** Сервер ответил не по всем заданиям (#260) — предупреждение, не ошибка. */
  liveWarning?: string
  /** Не удалось получить статус текущих загрузок. */
  liveError?: string
}>(), {
  live: () => [],
  uploading: false,
  liveWarning: '',
  liveError: ''
})

const { rows, loadError, loaded, page, canPrev, canNext, load, goto, retry, reload } = useImportJournal()

/**
 * Живые строки, которых журнал ещё не показывает.
 *
 * ⚠ ОТСЕВ ПО `jobId` ОБЯЗАТЕЛЕН, и это несущая часть слияния: как только импорт завершился, журнал
 * перечитывается и та же загрузка появляется в нём записью о деле. Без отсева один документ висел бы
 * в ленте ДВАЖДЫ — сверху «готово» из статуса задания, ниже дело о нём же, — и человек читал бы это
 * как два импорта одного файла.
 * ⚠ Отсев идёт от журнала к живым, а не наоборот: дело — источник, который переживает вкладку, а
 * живая строка временная. Значит побеждает запись журнала, и переключение происходит само.
 */
const liveVisible = computed(() => {
  const known = new Set(rows.value.map(r => r.jobId))
  return props.live.filter(j => !known.has(j.jobId))
})

/**
 * Перечитать журнал с начала — зовёт страница после завершения импорта.
 *
 * ⚠ Без этого только что загруженный документ не появлялся бы в журнале до перезагрузки страницы:
 * человек видит «Готово» в списке текущей пачки и пустоту (или вчерашние строки) в журнале прямо
 * под ним — два блока об одном и том же противоречат друг другу на одном экране.
 */
defineExpose({ reload })

/**
 * Rows prepared for rendering: parsed date tile and the owner-card path.
 *
 * ⚠ Считается ОДИН раз на строку, а не по вызову в разметке: плитка показывает четыре части одной
 * даты, и разбор в шаблоне выполнялся бы столько же раз на каждую строку при каждой перерисовке —
 * на списке в сотню строк это заметно, а на телефоне заметно вдвойне.
 * ⚠ `ownerPath` считается здесь по той же причине: в разметке он стоял бы в `v-if` и вычислялся
 * на каждую перерисовку, а показ кнопки и её действие обязаны решаться ОДНИМ значением — иначе
 * возможна кнопка, которая видна, но при нажатии ничего не делает.
 */
const view = computed(() => rows.value.map(row => ({
  row,
  tile: journalDateTile(row.createdAt),
  ownerPath: ownerOpenPath(row.ownerTypeId, row.ownerId),
  // Результат приходит уже разобранным с сервера (#495): в браузер уходят пять чисел, а не тело
  // дела целиком — там имя поставщика и тексты проблем из документа клиента.
  summary: row.summary,
  outcome: activityOutcome(row.colorId)
})))

onMounted(() => {
  void load()
})

/**
 * Open the CRM card the activity belongs to.
 *
 * ⚠ Это карточка-ВЛАДЕЛЕЦ: при найденном контрагенте — компания, а не созданная сделка. Путь
 * приходит готовым из `view` (чистая `ownerOpenPath`, знающая про тип 4); собирать его здесь
 * значило бы завести вторую копию правила и однажды забыть про компанию.
 */
async function openOwner(path: string): Promise<void> {
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
    <!-- ⚠ Заглушка ТОЛЬКО когда показывать реально нечего. Прежде она зависела лишь от журнала, и
         после слияния (#494) это скрыло бы идущий импорт: человек нажал «Импортировать», а вместо
         своих строк видит серые прямоугольники, пока портал отвечает на запрос журнала. Загрузка
         журнала не должна прятать то, что происходит прямо сейчас. -->
    <div
      v-if="!loaded && !liveVisible.length && !uploading && !liveWarning && !liveError"
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
      v-else-if="loadError && rows.length === 0 && !liveVisible.length && !uploading && !liveWarning && !liveError"
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
      v-else-if="rows.length === 0 && !liveVisible.length && !uploading && !liveWarning && !liveError"
      class="py-6 text-center text-sm text-(--ui-color-base-3)"
    >
      Вы ещё ничего не импортировали. Загрузите документ — он появится здесь.
    </p>

    <template v-else>
      <!-- ⚠ Своего контейнера прокрутки больше НЕТ (#495): постраничная навигация сделала его
           лишним, а во фрейме портала он мешал — приложение живёт в рамке, высоту которой Битрикс24
           подгоняет под содержимое, и вложенная прокрутка отбирала у человека привычную. -->
      <ul class="space-y-3">
        <!-- ⚠ Предупреждение и отказ ПО ЖИВЫМ строкам печатаются здесь. При слиянии списков
               (#494) блок, который их показывал, был удалён вместе со старым списком, и разбор это
               поймал: значения по-прежнему считались и даже управляли показом шапки, но САМ ТЕКСТ
               не выводился нигде — «ответ не покрыл все задания» молча исчезало, и человек считал
               список полным. Это про текущие загрузки, а не про журнал, поэтому стоит НАД ними. -->
        <li
          v-if="liveWarning"
          class="rounded-lg border border-(--ui-color-base-5) bg-(--ui-color-base-7) p-3 text-sm text-(--ui-color-base-3)"
        >
          {{ liveWarning }}
        </li>
        <li
          v-else-if="liveError && !live.length && !uploading"
          class="rounded-lg border border-(--ui-color-base-5) bg-(--ui-color-base-7) p-3 text-sm text-(--ui-color-base-3)"
        >
          Статус загрузок получить не удалось. Нажмите «Обновить» — если не поможет, закройте и
          откройте приложение заново.
        </li>
        <!-- Мгновенный отклик, пока POST в полёте и строки задания ещё нет вовсе. -->
        <li
          v-if="uploading"
          class="flex items-center gap-2 rounded-lg border border-(--ui-color-base-5) bg-(--ui-color-base-7) p-3 text-sm text-(--ui-color-base-3)"
        >
          <span class="inline-block size-2 shrink-0 animate-pulse rounded-full bg-(--ui-color-accent-main-primary)" />
          Отправляем файл…
        </li>
        <!-- ЖИВЫЕ строки — та же оболочка, что у записей журнала: слева индикатор вместо даты,
               справа шаги импорта. Завершилось и попало в журнал — строка исчезает отсюда и
               появляется ниже уже как дело (см. `liveVisible`). -->
        <ImportJobItem
          v-for="j in liveVisible"
          :key="j.jobId"
          :job="j"
        />
        <!-- ⚠ Строка списка сделана ПО МОТИВАМ дела в таймлайне Битрикс24 (решение владельца,
               скриншот 08.08.2026): плитка-календарь слева, цветная метка исхода, поля подписанными
               блоками, действие ссылкой внизу. Копия «один в один» не нужна и была бы вредна —
               у нас нет ни чекбокса «выполнено», ни кнопок дела, и рисовать их значило бы обещать
               действия, которых здесь нет. -->
        <li
          v-for="{ row, tile, ownerPath, summary, outcome } in view"
          :key="row.activityId"
          class="flex gap-3 rounded-lg border border-(--ui-color-base-5) bg-(--ui-color-base-8) p-3"
        >
          <!-- Плитка даты. ⚠ Она же ЕДИНСТВЕННЫЙ носитель даты: строка «10 августа 2026, 08:15»
                 под заголовком убрана (решение владельца 10.08.2026 — дата уже видна в плитке, а
                 повтор словами занимал строку в каждой записи). Поэтому дата объявляется программе
                 чтения ЗДЕСЬ: без `aria-label` плитка из трёх обрывков («10», «авг», «08:15»)
                 читалась бы вслух как три бессвязных числа, а с прежним `aria-hidden` дата исчезла
                 бы для незрячих вовсе. -->
          <div
            v-if="tile"
            class="flex w-14 shrink-0 flex-col items-center justify-center rounded-md bg-(--ui-color-base-7) py-1.5 text-center"
            role="img"
            :aria-label="`Загружено ${tile.day} ${tile.month} ${tile.year}, ${tile.time}`"
          >
            <span class="text-lg leading-none font-semibold">{{ tile.day }}</span>
            <span class="mt-0.5 text-[10px] leading-tight text-(--ui-color-base-3)">{{ tile.month }}</span>
            <span class="mt-0.5 text-[10px] leading-none text-(--ui-color-base-3)">{{ tile.time }}</span>
          </div>

          <!-- ⚠ Дата не разобралась ⇒ плитки нет, и строка обязана сказать об этом словами:
                 иначе запись выглядит как все остальные, только без даты, и человек читает это как
                 «сегодня». Заодно это страховка от мутации `v-if="tile"` → `v-if="true"`, которая
                 обращается к полям `null` и роняет весь список на первой такой строке. -->
          <div
            v-else
            class="flex w-14 shrink-0 items-center justify-center rounded-md bg-(--ui-color-base-7) px-1 py-1.5 text-center text-[10px] leading-tight text-(--ui-color-base-3)"
          >
            дата неизвестна
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-2">
              <p class="min-w-0 flex-1 truncate text-sm font-medium">
                {{ row.title }}
              </p>
              <!-- ⚠ Исход подписан СЛОВАМИ, а не только цветом: цвет один не читается программой
                     чтения и не различается при дальтонизме. Цвета те же, что у самого дела в
                     портале, — человек видит на двух экранах одно и то же. -->
              <!-- ⚠ Цвет берётся из САМОГО дела, а не из признака «дело закрыто»: связь была
                     односторонней, и перекрашенное в портале дело выглядело в журнале иначе, чем в
                     карточке. Неизвестный цвет — отдельный, НЕЙТРАЛЬНЫЙ исход: выдавать его за
                     успех значило бы утверждать о чужом документе непроверенное. -->
              <B24Badge
                class="shrink-0"
                size="xs"
                :color="outcome === 'clean' ? 'air-primary-success' : (outcome === 'issues' ? 'air-primary-alert' : 'air-secondary')"
                :label="journalOutcomeLabel(outcome)"
              />
            </div>
            <!-- Действие ссылкой, а не кнопкой: в деле портала оно выглядит так же, а кнопка в
                   каждой строке спорила бы за внимание с «Показать ещё» внизу списка.
                   ⚠ Своя рамка фокуса обязательна: у голого `<button>` её нет, а `B24Button`, у
                   которого она была, здесь не подходит по виду — без этого до ссылки нельзя
                   добраться с клавиатуры осмысленно (WCAG 2.4.7).
                   ⚠ Отступы (`-mx-1 px-1 py-1`) — тач-таргет: строка текста в 20 px на телефоне
                   промахивается пальцем; отрицательный внешний отступ возвращает текст на прежнее
                   место по левому краю. -->
            <!-- РЕЗУЛЬТАТ импорта — из тела дела (#495). Пустых подписей не печатаем: блок,
                   который иногда пуст, читается как «данных нет», а не «поле не заполнено». -->
            <p
              v-if="summary.rows != null || summary.amount || summary.supplier"
              class="mt-1 text-xs text-(--ui-color-base-2)"
            >
              <span v-if="summary.supplier">{{ summary.supplier }}</span>
              <span v-if="summary.supplier && (summary.rows != null || summary.amount)"> · </span>
              <span v-if="summary.rows != null">позиций: {{ summary.rows }}<template v-if="summary.matched != null"> (сопоставлено {{ summary.matched }})</template></span>
              <span v-if="summary.rows != null && summary.amount"> · </span>
              <span v-if="summary.amount">{{ summary.amount }}</span>
            </p>
            <p
              v-if="summary.problems"
              class="mt-0.5 text-xs text-(--ui-color-accent-main-alert)"
            >
              проблем: {{ summary.problems }} — подробности в карточке
            </p>

            <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <button
                v-if="ownerPath"
                type="button"
                class="-mx-1 mt-1 rounded px-1 py-1 text-sm text-(--ui-color-accent-main-link) hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-color-accent-main-primary)"
                @click="openOwner(ownerPath)"
              >
                Открыть карточку
              </button>
              <!-- ИСХОДНЫЙ ФАЙЛ — вложение дела (#495). ⚠ Новой вкладкой (решение владельца): это
                     адрес ПОРТАЛА, а не наш, и открытие его в нашем фрейме увело бы человека с
                     рабочего экрана. `noopener` обязателен — иначе открытая страница получает
                     ссылку на наше окно. -->
              <a
                v-if="row.fileUrl"
                :href="row.fileUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="-mx-1 rounded px-1 py-1 text-sm text-(--ui-color-accent-main-link) hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-color-accent-main-primary)"
              >
                Исходный файл
              </a>
            </div>

            <!-- Отзыв — у КАЖДОЙ записи журнала (решение владельца 10.08.2026). Документ к отзыву
                   сервер читает из вложения дела (#461), а не из памяти страницы, поэтому это
                   работает и по вчерашним записям. -->
            <FeedbackWidget
              :job-id="row.jobId"
              :file-name="row.title"
            />
          </div>
        </li>
      </ul>

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

      <!-- Постраничная навигация: предсказуема, работает с клавиатуры и не требует прокрутки. -->
      <div
        v-else-if="canPrev || canNext"
        class="mt-3 flex items-center justify-between gap-2"
      >
        <B24Button
          size="sm"
          color="air-secondary-no-accent"
          label="Назад"
          :disabled="!canPrev"
          @click="() => goto(page - 1)"
        />
        <!-- Номер страницы, а не «N из M»: сколько всего записей, портал в этом ответе не говорит,
             и выдуманный итог был бы утверждением, которого мы не проверяли. -->
        <span class="text-xs text-(--ui-color-base-3)">Страница {{ page + 1 }}</span>
        <B24Button
          size="sm"
          color="air-secondary-no-accent"
          label="Дальше"
          :disabled="!canNext"
          @click="() => goto(page + 1)"
        />
      </div>
    </template>
  </B24PageCard>
</template>
