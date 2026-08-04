<script setup lang="ts">
import { computed } from 'vue'
import { canonicalUrl } from '~/utils/landing'
import { PUBLISHER } from '~/config/publisher'
import { SHELL_BG_CLASS, SHELL_CLASS, SHELL_VARS } from '~/config/landingShell'
import { archivePath, editionPath, findArchiveDoc, isCurrentEdition, supersededLabel } from '~/utils/legalArchive'

// Архив редакций одного документа (#415): список, новая сверху.
//
// Оболочка та же, что у самих документов, и берётся из общего источника (`config/landingShell`) —
// человек попадает сюда со страницы документа, и чужой фон читался бы как другой сайт. Копия этой
// пары уже однажды разъехалась (#368: фон скопировали, цвет текста нет), поэтому литералов тут нет.

const props = defineProps<{ slug: string }>()

const doc = computed(() => findArchiveDoc(props.slug))
const title = computed(() => `${doc.value?.title ?? 'Документ'}: архив редакций`)
const description = computed(() =>
  `Все редакции документа «${doc.value?.title ?? ''}» с датами вступления в силу и замены. Постоянные адреса текстов.`)

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogType: 'article'
})
useHead({
  link: [{ rel: 'canonical', href: canonicalUrl(archivePath(props.slug)) }],
  bodyAttrs: { class: SHELL_BG_CLASS },
  htmlAttrs: { 'data-force-dark': 'true' }
})
</script>

<template>
  <main
    :class="`legal-shell mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14 ${SHELL_CLASS}`"
    :style="SHELL_VARS"
  >
    <p class="mb-6 text-sm">
      <NuxtLink
        :to="`/${slug}`"
        class="underline"
      >← К действующей редакции</NuxtLink>
    </p>
    <h1 class="mb-6 text-3xl font-semibold sm:text-4xl">
      {{ title }}
    </h1>

    <!-- ⚠ Про обратную силу пишем ТОЛЬКО там, где документ это говорит: в `site-terms.md` и
         `site-privacy.md` такого пункта нет вовсе. Печатать за издателя обязательство сильнее, чем
         в самом документе, хуже, чем не печатать ничего. -->
    <p
      v-if="doc?.noRetroactivity"
      class="mb-6"
    >
      Изменения документа не имеют обратной силы: к отношениям, возникшим до вступления новой
      редакции в силу, применяется редакция, действовавшая на момент их возникновения.
    </p>
    <!-- ⚠ Обещание срока — ровно то, что стоит в самом документе («не менее 3 (трёх) лет с даты
         замены»: eula 9.3.8, privacy-policy 13.4, site-terms 8.3, site-privacy 9.3). Прежняя
         формулировка «адрес не меняется никогда» была обязательством сильнее документа и ни на
         чём не основана — это тот же дефект, что абзац про обратную силу строкой выше. -->
    <p class="mb-6">
      У каждой редакции свой адрес. Заменённые редакции остаются в открытом доступе не менее
      3 (трёх) лет с даты замены.
    </p>

    <!-- Прокрутка живёт на ОБЁРТКЕ, а не на самой таблице: `display:block` на `<table>` в части
         связок «браузер + диктор» снимает табличную семантику, и `<th>` перестают объявляться
         заголовками. Подсказка о прокрутке — текстом ниже, иначе на телефоне колонка «Текст»
         просто за краем экрана и страница выглядит так, будто открыть нечего. -->
    <!-- ⚠ `tabindex="0"` + `role="region"` + имя — не украшение: прокручиваемая область без фокуса
         недоступна с клавиатуры (WCAG 2.1.1). На узком экране колонка со ссылкой «Открыть» уезжает
         за край, и без этого до неё нельзя добраться осознанно — только вслепую табуляцией. -->
    <div
      class="archive-scroll"
      role="region"
      tabindex="0"
      :aria-label="`Таблица редакций: ${doc?.title ?? 'документ'}`"
    >
      <table class="archive-table">
        <thead>
          <tr>
            <th>Редакция</th>
            <th>Вступила в силу</th>
            <th>Заменена</th>
            <th>Текст</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="e in doc?.editions ?? []"
            :key="e.date"
          >
            <!-- `th scope="row"` не косметика: без него в списке ссылок у экранного диктора четыре
               одинаковых «Открыть» без признака, к какой редакции они ведут. -->
            <th scope="row">
              {{ e.date }}
              <!-- Действующую помечаем ЯВНО: в списке из нескольких строк её иначе не отличить,
                 а перепутанная редакция — худший исход для страницы, заведённой ради точности.
                 Пометка — СЛОВО, а не только начертание: диктор прочтёт её в любом случае. -->
              <strong v-if="isCurrentEdition(e)"> · действующая</strong>
            </th>
            <td>{{ e.effective }}</td>
            <td>{{ supersededLabel(e) }}</td>
            <td>
              <NuxtLink
                :to="editionPath(slug, e.date)"
                :aria-label="`Открыть редакцию от ${e.date}`"
                class="underline"
              >Открыть</NuxtLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="mt-2 text-sm legal-muted sm:hidden">
      Таблицу можно прокрутить вбок — в последней колонке ссылка на текст редакции.
    </p>

    <p class="mt-10 text-sm legal-muted">
      {{ PUBLISHER.legalName }} · УНП {{ PUBLISHER.unp }} ·
      <a
        :href="`mailto:${PUBLISHER.email}`"
        class="underline"
      >{{ PUBLISHER.email }}</a>
    </p>
    <p class="mt-2 text-sm">
      <NuxtLink
        to="/"
        class="underline"
      >На главную</NuxtLink>
    </p>
  </main>
</template>

<style scoped>
.archive-scroll { overflow-x: auto; }
.archive-table { border-collapse: collapse; }
.archive-table th, .archive-table td {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--legal-border);
  text-align: left;
  vertical-align: top;
}
.legal-muted { color: var(--legal-muted); }
</style>
