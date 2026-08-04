<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '~/utils/markdownLite'
import { canonicalUrl } from '~/utils/landing'
import { PUBLISHER } from '~/config/publisher'
import { SHELL_BG_CLASS, SHELL_CLASS, SHELL_VARS } from '~/config/landingShell'
import type { LegalEditionEntry } from '~/config/legalArchive'
import { isCurrentEdition } from '~/utils/legalArchive'

// Public legal page (#297, вариант В). The SOURCE is the markdown file in `docs/` — the page renders
// it, it does not restate it. That is the whole point of the chosen option: a lawyer edits one file,
// and the published page cannot go stale, because there is no second copy to forget.
//
// The two legal pages are the ONLY pages besides the landing that are indexable: the Bitrix24 Market
// requires them at permanent public HTTPS addresses, and a `noindex` document is a worse answer to a
// moderator than an indexed one. The guard test that enforces «only the landing is indexed» knows
// about this exception by name.
const props = defineProps<{
  /** Raw markdown of the document (imported with `?raw` by the page). */
  source: string
  title: string
  /** Site-relative path, e.g. `/eula` — used for the canonical link. */
  path: string
  description: string
  /** Сегмент архива редакций (#415): `eula`, `privacy`, … Пусто — ссылки на архив нет. */
  archiveSlug?: string
  /** Заполнено, когда страница показывает редакцию из архива (действующую или заменённую). */
  edition?: LegalEditionEntry
}>()

// Архивная редакция — та, что уже заменена. Её обязательно пометить: перепутанная с действующей,
// она хуже отсутствия архива — человек прочтёт недействующий текст как обязывающий.
//
// ⚠ Признак берём из ОБЩЕГО хелпера, а не пересчитываем здесь: это главный инвариант всей задачи,
// и вторая его копия — ровно тот случай, когда одна сторона однажды поедет, а тестом покрыта другая.
const isArchived = computed(() => Boolean(props.edition && !isCurrentEdition(props.edition)))

const html = computed(() => renderMarkdown(props.source))

// Заголовок страницы редакции обязан отличаться от заголовка документа: одинаковые `<title>` на
// двух индексируемых адресах — это дубль в выдаче и путаница в закладках.
const pageTitle = computed(() => (props.edition ? `${props.title} — редакция от ${props.edition.date}` : props.title))

useSeoMeta({
  title: pageTitle,
  description: () => props.description,
  ogTitle: pageTitle,
  ogDescription: () => props.description,
  ogType: 'article'
})
// Тёмная брендовая оболочка — та же, что у лендинга: человек приходит сюда по ссылке из подвала
// (или из карточки Маркета), и страница без бренда читается как чужой сайт. Своего layout у лендинга
// нет, поэтому фон и передний план берутся из общего источника (`config/landingShell`), а не
// переписываются здесь заново: копия этой пары уже разъехалась — фон скопировали, текст нет (#368).
// `bodyAttrs` красит поле ЗА контентом (короткий документ не закрывает экран целиком), а `SHELL_CLASS`
// на корне — сам контент.
// ⚠ Канонический адрес страницы ДЕЙСТВУЮЩЕЙ редакции — сам документ (`/eula`), а не её постоянный
// адрес: тексты там байт в байт одинаковые, и две само-канонические страницы с одинаковым телом —
// это дубль на тех самых адресах, которые открывает модератор Маркета. У ЗАМЕНЁННОЙ редакции
// канонический адрес свой: её текста больше нигде нет, и склеивать её с действующей нельзя.
const canonicalPath = computed(() => (props.edition && !isArchived.value && props.archiveSlug ? `/${props.archiveSlug}` : props.path))

useHead({
  link: [{ rel: 'canonical', href: canonicalUrl(canonicalPath.value) }],
  bodyAttrs: { class: SHELL_BG_CLASS },
  htmlAttrs: { 'data-force-dark': 'true' }
})
</script>

<template>
  <main
    :class="`legal-shell mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14 ${SHELL_CLASS}`"
    :style="SHELL_VARS"
  >
    <!-- Ссылка наверху, а не только внизу: на страницу попадают прямой ссылкой из карточки
         Маркета, и до нижней навигации пришлось бы пролистать весь документ. -->
    <p class="mb-6 text-sm">
      <NuxtLink
        to="/"
        class="underline"
      >← На главную</NuxtLink>
    </p>
    <h1 class="mb-6 text-3xl font-semibold sm:text-4xl">
      {{ title }}
    </h1>
    <!-- Плашка редакции. У архивной — предупреждение с датой замены и ссылкой на действующую:
         иначе человек, пришедший по постоянной ссылке из старого договора, прочтёт недействующий
         текст как обязывающий. У действующей — спокойная пометка, что она действующая. -->
    <div
      v-if="edition"
      class="mb-6 rounded-lg border px-4 py-3 text-sm"
      :style="{ borderColor: 'var(--legal-border)' }"
    >
      <p v-if="isArchived">
        <strong>Архивная редакция.</strong> Действовала с {{ edition.effective }} по
        {{ edition.supersededAt }}. Текст приведён в том виде, в каком был опубликован.
        <NuxtLink
          :to="`/${archiveSlug}`"
          class="underline"
        >Открыть действующую редакцию</NuxtLink>
      </p>
      <p v-else>
        <strong>Действующая редакция.</strong> Вступила в силу {{ edition.effective }}.
      </p>
    </div>
    <!-- Источник — наш собственный файл в репозитории, и рендер экранирует ВСЁ до разбора
         конструкций (см. markdownLite): сырой HTML из документа выводится текстом, а не исполняется.
         Это единственное место в проекте с v-html, и оно обосновано именно этим. -->
    <!-- eslint-disable-next-line vue/no-v-html -- источник наш, а рендер экранирует всё до разбора -->
    <article
      class="legal-body"
      v-html="html"
    />
    <p class="mt-10 text-sm legal-muted">
      {{ PUBLISHER.legalName }} · УНП {{ PUBLISHER.unp }} ·
      <a
        :href="`mailto:${PUBLISHER.email}`"
        class="underline"
      >{{ PUBLISHER.email }}</a>
    </p>
    <p
      v-if="archiveSlug"
      class="mt-2 text-sm"
    >
      <NuxtLink
        :to="`/${archiveSlug}/archive`"
        class="underline"
      >Все редакции документа</NuxtLink>
    </p>
    <!-- Пара «лицензия ↔ политика» имеет смысл только на самих документах: на странице редакции
         `path` это `/…/archive/<дата>`, и прежнее условие уводило КАЖДУЮ такую страницу на `/eula` —
         в том числе саму лицензию на себя же. -->
    <p
      v-if="!edition"
      class="mt-2 text-sm"
    >
      <NuxtLink
        to="/"
        class="underline"
      >На главную</NuxtLink>
      ·
      <NuxtLink
        :to="path === '/eula' ? '/privacy' : '/eula'"
        class="underline"
      >{{ path === '/eula' ? 'Политика конфиденциальности' : 'Лицензионное соглашение' }}</NuxtLink>
    </p>
    <p
      v-else
      class="mt-2 text-sm"
    >
      <NuxtLink
        to="/"
        class="underline"
      >На главную</NuxtLink>
    </p>
  </main>
</template>

<style scoped>
/* Типографика документа: читаемая ширина строки и явная иерархия — юридический текст читают
   подряд, а не сканируют. Таблицы прокручиваются по горизонтали: в политике есть широкие. */
.legal-body :deep(h2) { margin: 2rem 0 0.75rem; font-size: 1.25rem; font-weight: 600; }
.legal-body :deep(h3) { margin: 1.5rem 0 0.5rem; font-size: 1.05rem; font-weight: 600; }
.legal-body :deep(p) { margin: 0.75rem 0; line-height: 1.65; }
.legal-body :deep(ul), .legal-body :deep(ol) { margin: 0.75rem 0 0.75rem 1.25rem; line-height: 1.65; }
.legal-body :deep(li) { margin: 0.25rem 0; list-style: disc; }
.legal-body :deep(ol li) { list-style: decimal; }
.legal-body :deep(hr) { margin: 2rem 0; border-top: 1px solid var(--legal-border); }
.legal-body :deep(blockquote) {
  margin: 1rem 0;
  padding: 0.5rem 0 0.5rem 0.75rem;
  border-left: 3px solid var(--legal-border);
  color: var(--legal-quote);
}
.legal-body :deep(a) { color: var(--legal-link); text-decoration: underline; }
.legal-muted { color: var(--legal-muted); }
.legal-body :deep(code) { font-size: 0.9em; }
.legal-body :deep(table) { display: block; overflow-x: auto; margin: 1rem 0; border-collapse: collapse; }
.legal-body :deep(th), .legal-body :deep(td) {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--legal-border);
  text-align: left;
  vertical-align: top;
}
</style>
