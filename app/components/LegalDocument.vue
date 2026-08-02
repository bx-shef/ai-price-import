<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '~/utils/markdownLite'
import { canonicalUrl } from '~/utils/landing'
import { PUBLISHER } from '~/config/publisher'

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
}>()

const html = computed(() => renderMarkdown(props.source))

useSeoMeta({
  title: props.title,
  description: props.description,
  ogTitle: props.title,
  ogDescription: props.description,
  ogType: 'article'
})
// Тёмная брендовая оболочка — та же, что у лендинга: человек приходит сюда по ссылке из подвала
// (или из карточки Маркета), и страница без бренда читается как чужой сайт. Своего layout у лендинга
// нет — он выставляет эти же атрибуты сам, поэтому повторяем их, а не заводим третий вариант темы.
useHead({
  link: [{ rel: 'canonical', href: canonicalUrl(props.path) }],
  bodyAttrs: { class: 'bg-[#05010f]' },
  htmlAttrs: { 'data-force-dark': 'true' }
})
</script>

<template>
  <main class="legal-shell mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
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
    <!-- Источник — наш собственный файл в репозитории, и рендер экранирует ВСЁ до разбора
         конструкций (см. markdownLite): сырой HTML из документа выводится текстом, а не исполняется.
         Это единственное место в проекте с v-html, и оно обосновано именно этим. -->
    <!-- eslint-disable-next-line vue/no-v-html -- источник наш, а рендер экранирует всё до разбора -->
    <article
      class="legal-body"
      v-html="html"
    />
    <p class="mt-10 text-sm text-(--ui-color-base-4)">
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
      ·
      <NuxtLink
        :to="path === '/eula' ? '/privacy' : '/eula'"
        class="underline"
      >{{ path === '/eula' ? 'Политика конфиденциальности' : 'Лицензионное соглашение' }}</NuxtLink>
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
.legal-body :deep(hr) { margin: 2rem 0; border-top: 1px solid var(--ui-color-base-5); }
.legal-body :deep(blockquote) {
  margin: 1rem 0;
  padding: 0.5rem 0 0.5rem 0.75rem;
  border-left: 3px solid var(--ui-color-base-5);
  color: var(--ui-color-base-3);
}
.legal-body :deep(a) { text-decoration: underline; }
.legal-body :deep(code) { font-size: 0.9em; }
.legal-body :deep(table) { display: block; overflow-x: auto; margin: 1rem 0; border-collapse: collapse; }
.legal-body :deep(th), .legal-body :deep(td) {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--ui-color-base-5);
  text-align: left;
  vertical-align: top;
}
</style>
